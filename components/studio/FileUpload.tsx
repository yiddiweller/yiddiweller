"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  abandonUploadAction,
  authorizeUploadAction,
  finalizeUploadAction,
} from "@/app/studio/(app)/workrooms/[id]/files/actions";
import styles from "@/app/studio/studio.module.css";

/**
 * Sending a file to the bucket, from here.
 *
 * The bytes go browser → storage directly and never touch the Next server.
 * This component asks for authorization, does the transfer itself, and then
 * asks the server to verify what arrived — it is the only client code in
 * Build 005 and it holds no credential of its own beyond a URL that expires.
 *
 * A real `<input type="file">`, always. Drag-and-drop may be added on top one
 * day; it is never the only way in, because a keyboard has to reach this.
 */

type Props = { workroomId: string; supersedesFileId?: string; label?: string };

type Phase = { state: "idle" | "working" | "done" | "failed"; message: string; percent: number };

const IDLE: Phase = { state: "idle", message: "", percent: 0 };

export default function FileUpload({ workroomId, supersedesFileId, label }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>(IDLE);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function send(file: File) {
    setPhase({ state: "working", message: `Sending ${file.name}`, percent: 0 });

    const authorized = await authorizeUploadAction({
      workroomId,
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      supersedesFileId: supersedesFileId ?? null,
    });

    if (!authorized.ok) {
      setPhase({ state: "failed", message: authorized.message, percent: 0 });
      return;
    }

    const { fileId, strategy, urls, uploadId, partSize, previewUrl } = authorized.value;

    try {
      const parts: { partNumber: number; etag: string }[] = [];

      if (strategy === "single") {
        await put(urls[0]!, file, file.type);
        setPhase({ state: "working", message: `Sending ${file.name}`, percent: 90 });
      } else {
        // One part at a time rather than all at once: a studio uploading two
        // gigabytes over a domestic connection does better with a queue than
        // with 128 simultaneous requests competing for the same uplink.
        for (let index = 0; index < urls.length; index++) {
          const from = index * partSize;
          const chunk = file.slice(from, Math.min(from + partSize, file.size));
          const etag = await put(urls[index]!, chunk, file.type);
          if (!etag) throw new Error("storage did not acknowledge a part");
          parts.push({ partNumber: index + 1, etag });
          setPhase({
            state: "working",
            message: `Sending ${file.name}`,
            percent: Math.round(((index + 1) / urls.length) * 90),
          });
        }
      }

      // A preview is a convenience. Failing to make one must never fail the
      // upload, so this is deliberately swallowed.
      let previewUploaded = false;
      if (previewUrl) {
        try {
          const preview = await shrink(file);
          if (preview) {
            await put(previewUrl, preview, "image/jpeg");
            previewUploaded = true;
          }
        } catch {
          previewUploaded = false;
        }
      }

      const finalized = await finalizeUploadAction({
        workroomId,
        fileId,
        declaredSize: file.size,
        ...(uploadId ? { uploadId, parts } : {}),
        previewUploaded,
      });

      if (!finalized.ok) {
        setPhase({ state: "failed", message: finalized.message, percent: 0 });
        return;
      }

      setPhase({ state: "done", message: `${file.name} stored.`, percent: 100 });
      startTransition(() => router.refresh());
    } catch {
      // The row stays `pending` and the sweep would eventually clear it; asking
      // now is tidier and costs one request.
      await abandonUploadAction({ workroomId, fileId });
      setPhase({
        state: "failed",
        message: "That upload did not finish. Nothing was stored — try again.",
        percent: 0,
      });
    }
  }

  return (
    <div className={styles.upload}>
      <label className={styles.label} htmlFor="file-upload">
        {label ?? "Add a file"}
      </label>
      <input
        id="file-upload"
        ref={input}
        className={styles.fileInput}
        type="file"
        disabled={phase.state === "working"}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void send(file);
          event.target.value = "";
        }}
      />

      {phase.state === "working" ? (
        <p
          className={styles.uploadStatus}
          role="progressbar"
          aria-valuenow={phase.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={phase.message}
        >
          {phase.message} — {phase.percent}%
        </p>
      ) : null}

      {phase.state !== "idle" && phase.state !== "working" ? (
        <p className={styles.uploadStatus} role="status">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}

/** A presigned PUT, returning the part's ETag when storage sends one. */
async function put(url: string, body: Blob, contentType: string): Promise<string | null> {
  const response = await fetch(url, {
    method: "PUT",
    body,
    headers: contentType ? { "Content-Type": contentType } : {},
  });
  if (!response.ok) throw new Error(`storage refused the upload (${response.status})`);
  return response.headers.get("etag")?.replaceAll('"', "") ?? null;
}

/**
 * A small JPEG of an image, made by the browser.
 *
 * No server-side image processing anywhere in this build, so this is the whole
 * preview story: one canvas, one `toBlob`, and a client on a phone fetches
 * about 80 KB instead of a 40 MB original. Returns null for anything the
 * browser will not decode, which includes SVG — decoding one runs its contents.
 */
async function shrink(file: File): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function") return null;

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > 1280 ? 1280 / longest : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));

  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
}
