import Link from "next/link";
import { notFound } from "next/navigation";

import FileViewer from "@/components/workrooms/FileViewer";
import { requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { fileForStaff } from "@/lib/db/files";
import { findWorkroom } from "@/lib/db/workrooms";
import { fileKind, formatBytes, viewerKind } from "@/lib/storage/policy";
import { isPublicId } from "@/lib/workrooms/id";
import studio from "@/app/studio/studio.module.css";
import styles from "@/app/workrooms/workroom.module.css";

export const metadata = { title: "File" };

/**
 * The same file, opened from Studio.
 *
 * Staff authorization and no visibility filter — inspecting an internal file
 * before it is shared is most of the point. It renders the **same**
 * `FileViewer` the client's page does, so what may be shown inline is decided
 * in one place for both worlds, and a future viewer type cannot arrive on one
 * surface and not the other.
 *
 * The routes it is handed are Studio's own, so the bytes come through staff
 * authorization. There is no path here that reads a client session.
 */
export default async function StudioFile({
  params,
}: {
  params: Promise<{ id: string; fileId: string }>;
}) {
  await requireStaff();
  const { id, fileId } = await params;
  if (!isId(id) || !isPublicId(fileId)) notFound();

  const [room, file] = await Promise.all([findWorkroom(id), fileForStaff(fileId)]);
  if (!room || !file || file.workroomId !== id) notFound();

  const kind = viewerKind(file.contentType);
  const base = `/studio/workrooms/${room.id}/files/${file.publicId}`;

  return (
    <>
      <Link className={studio.back} href={`/studio/workrooms/${room.id}/files`}>
        ← Files
      </Link>

      <header className={studio.pageHeader}>
        <h1 className={studio.pageTitle}>{file.displayName}</h1>
        <p className={studio.pageMeta}>
          {fileKind(file.contentType)} · {formatBytes(file.byteSize ?? 0)} ·{" "}
          {file.visibility === "shared" ? "Shared with the client" : "Internal"}
        </p>
      </header>

      <div className={`${styles.tokens} ${studio.section}`}>
        <FileViewer
          kind={kind}
          source={kind === "download" ? undefined : `${base}/view`}
          name={file.displayName}
        />
      </div>

      <p className={studio.sectionNote}>
        <a className={studio.buttonSecondary} href={`${base}/download`}>
          Download original
        </a>
      </p>
    </>
  );
}
