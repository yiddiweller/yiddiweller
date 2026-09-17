import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { storage } from "./client.ts";

/**
 * Every operation this build performs against object storage.
 *
 * Bytes never pass through this server in either direction: uploads are
 * presigned and go browser → bucket, downloads are a redirect to a presigned
 * GET. What travels through here is authorization, verification and metadata.
 *
 * Presigned URLs are minted per request and live for seconds. One in an inbox
 * is a credential in an inbox, so none is ever emailed, logged, or written into
 * HTML.
 */

/** Long enough to follow a redirect, short enough to be worthless if copied. */
const DOWNLOAD_TTL_SECONDS = 60;
/** Long enough to upload a 16 MiB part on a poor connection. */
const UPLOAD_TTL_SECONDS = 15 * 60;

/** Above this, one PUT has no resume and a dropped connection starts again. */
export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024;
/** 2 GB at 16 MiB is 128 parts — far under the 10,000-part limit. */
export const MULTIPART_PART_BYTES = 16 * 1024 * 1024;

export type ObjectFacts = { size: number; etag: string };

/**
 * What is actually there, asked with our own credentials.
 *
 * **This is the guarantee the whole upload flow rests on.** A presigned PUT
 * cannot enforce a size — `content-length-range` belongs to S3's browser POST
 * policy, a different mechanism — so the ceiling is not enforced at upload
 * time. It is enforced here, afterwards, against what the bucket says it holds.
 */
export async function headObject(key: string): Promise<ObjectFacts | null> {
  const { client, bucket } = storage();
  try {
    const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const size = result.ContentLength;
    const etag = result.ETag;
    if (typeof size !== "number" || !etag) return null;
    // Opaque: compared against itself, never parsed. A multipart ETag is not an
    // MD5 of the content and a provider is not obliged to use any given shape.
    return { size, etag: etag.replaceAll('"', "") };
  } catch (cause) {
    if (isNotFound(cause)) return null;
    throw cause;
  }
}

/** Server-side copy. The browser never holds a URL that can write to `to`. */
export async function copyObject(from: string, to: string): Promise<void> {
  const { client, bucket } = storage();
  await client.send(
    new CopyObjectCommand({
      Bucket: bucket,
      // The source is bucket-qualified and must be encoded: a key is a path,
      // and the provider parses this field rather than receiving it as data.
      CopySource: `${bucket}/${from}`.split("/").map(encodeURIComponent).join("/"),
      Key: to,
    }),
  );
}

/** Idempotent by contract: a key that is already gone is success. */
export async function deleteObject(key: string): Promise<void> {
  const { client, bucket } = storage();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
}

/** One presigned PUT, for anything under the multipart threshold. */
export async function presignPut(key: string, contentType: string): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: UPLOAD_TTL_SECONDS },
  );
}

/**
 * A presigned GET, with the disposition forced at signing time.
 *
 * The filename is sanitised to ASCII and given an RFC 5987 companion, so a
 * display name carrying quotes, newlines or non-Latin characters cannot inject
 * a header. `attachment` is not negotiable: an uploaded SVG or HTML document
 * served inline from a trusted origin is stored XSS, and content type is
 * metadata here rather than a rendering instruction.
 */
export async function presignGet(key: string, filename: string): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      ResponseContentDisposition: contentDisposition(filename),
      ResponseContentType: "application/octet-stream",
    }),
    { expiresIn: DOWNLOAD_TTL_SECONDS },
  );
}

/** A presigned GET for a browser-made image preview, shown inline. */
export async function presignPreview(key: string): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: DOWNLOAD_TTL_SECONDS,
  });
}

/* ------------------------------------------------------------- multipart */

export async function createMultipart(key: string, contentType: string): Promise<string> {
  const { client, bucket } = storage();
  const result = await client.send(
    new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
  );
  if (!result.UploadId) throw new Error("storage did not return an upload id");
  return result.UploadId;
}

export async function presignPart(
  key: string,
  uploadId: string,
  partNumber: number,
): Promise<string> {
  const { client, bucket } = storage();
  return getSignedUrl(
    client,
    new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: UPLOAD_TTL_SECONDS },
  );
}

export async function completeMultipart(
  key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
): Promise<void> {
  const { client, bucket } = storage();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }),
  );
}

/* --------------------------------------------------------------- helpers */

/**
 * A `Content-Disposition` a hostile filename cannot escape.
 *
 * The quoted form is stripped to a conservative ASCII subset — anything else
 * becomes `_`, and a name that reduces to nothing becomes `download`. The
 * `filename*` form carries the real name, percent-encoded, for clients that
 * understand RFC 5987. Neither can contain a quote, a newline or a semicolon,
 * so neither can end the header early.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    // Runs of dots collapse to one. A filename is not a path and every browser
    // strips directory components anyway — but `..` in a name a naive client
    // might join onto a directory is a worry that costs one line to remove.
    .replace(/\.{2,}/g, ".")
    .replace(/^[._ -]+/, "")
    .slice(0, 120)
    .trim();
  const safe = ascii.length > 0 ? ascii : "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

function isNotFound(cause: unknown): boolean {
  const error = cause as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    error?.name === "NotFound" ||
    error?.name === "NoSuchKey" ||
    error?.$metadata?.httpStatusCode === 404
  );
}
