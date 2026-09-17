import Link from "next/link";
import { notFound } from "next/navigation";

import FileViewer from "@/components/workrooms/FileViewer";
import { requireViewer } from "@/lib/client-auth/guard";
import { fileForViewer } from "@/lib/db/files";
import { workroomForViewer } from "@/lib/db/workrooms";
import { toClientFile } from "@/lib/workrooms/delivery-view";
import { isPublicId } from "@/lib/workrooms/id";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * One file, opened.
 *
 * `requireViewer` runs here, before the first read, and `fileForViewer` carries
 * membership, published state, ownership, readiness, visibility and archive
 * state in one `WHERE` — the same read the download and view routes perform. So
 * reaching this page and being served its bytes are the same question asked
 * twice, and neither answer depends on the other having been asked.
 *
 * This page sets no title, like every page under `/workrooms`: they all inherit
 * the layout's generic "Workroom", so a title says nothing about the work and
 * nothing about which page somebody is on.
 */
export default async function ClientFile({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  const viewer = await requireViewer();
  const { id, fileId } = await params;
  if (!isPublicId(id) || !isPublicId(fileId)) notFound();

  const [room, row] = await Promise.all([
    workroomForViewer(viewer.contactId, id),
    fileForViewer(viewer.contactId, id, fileId),
  ]);
  if (!room || !row) notFound();

  const file = toClientFile(row, id);

  return (
    <>
      <p className={styles.eyebrow}>
        <Link className={styles.quiet} href={`/workrooms/${id}/files`}>
          ← Files
        </Link>
      </p>
      <h1 className={styles.viewerTitle}>{file.name}</h1>
      <p className={styles.viewerMeta}>
        {file.kind} · {file.size}
      </p>

      <FileViewer kind={file.viewer} source={file.sourcePath} name={file.name} />

      {/* Always offered, for every file, whether or not it can be viewed. The
          thing a client was sent is the original — what is above is a way of
          looking at it, never a replacement for having it. */}
      <p className={styles.viewerActions}>
        <a className={styles.viewerDownload} href={file.downloadPath}>
          Download original
        </a>
      </p>
    </>
  );
}
