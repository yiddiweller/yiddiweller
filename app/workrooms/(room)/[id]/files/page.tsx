import Link from "next/link";
import { notFound } from "next/navigation";

import { requireViewer } from "@/lib/client-auth/guard";
import { filesForViewer } from "@/lib/db/files";
import { workroomForViewer } from "@/lib/db/workrooms";
import { toClientFiles } from "@/lib/workrooms/delivery-view";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * Everything the studio has given this client, in one place.
 *
 * `requireViewer` runs here, before the first read, and the read itself carries
 * the membership — so a request from somebody who is not a member never fetches
 * a row.
 *
 * **This page deliberately sets no title.** Every page under `/workrooms`
 * inherits the layout's generic "Workroom", so the title says nothing about
 * the work and nothing about which page you are on — and a refused request,
 * which still produces a title, carries the same one as everybody else's.
 *
 * Adding `export const metadata = { title: "Files" }` here would also render as
 * a bare "Files" rather than "Files — Yiddi Weller": the layout above sets a
 * plain string title, which stops the root template propagating any further
 * down. Measured, not assumed.
 */

export default async function ClientFiles({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;

  const room = await workroomForViewer(viewer.contactId, id);
  if (!room) notFound();

  const files = toClientFiles(await filesForViewer(viewer.contactId, id), id);

  return (
    <>
      <p className={styles.eyebrow}>
        <Link className={styles.quiet} href={`/workrooms/${id}`}>
          ← {room.title}
        </Link>
      </p>
      <h1 className={styles.display}>Files</h1>

      <div className={styles.sections}>
        <section className={styles.section}>
          {files.length === 0 ? (
            <p className={styles.empty}>
              Nothing has been shared yet. Files will appear here as the work goes on.
            </p>
          ) : (
            <ul className={styles.files}>
              {files.map((file) => (
                <li key={file.id} className={styles.file}>
                  {/* The thumbnail is the way in when there is one. A raster
                      image gets a picture of itself; everything else gets its
                      name and type, which is what a PDF or a zip honestly
                      looks like. */}
                  {file.previewPath && file.viewPath ? (
                    <Link className={styles.filePreview} href={file.viewPath}>
                      <img
                        className={styles.filePreviewImage}
                        src={file.previewPath}
                        alt={`Open ${file.name}`}
                        loading="lazy"
                        decoding="async"
                      />
                    </Link>
                  ) : null}

                  <div className={styles.fileRow}>
                    <span className={styles.fileLink}>{file.name}</span>
                    <span className={styles.fileMeta}>
                      {file.kind} · {file.size}
                    </span>
                  </div>

                  {/* Two actions at most, and the hierarchy reads without
                      explanation: open it, or take it away. A file with no
                      viewer simply has one. */}
                  <div className={styles.fileActions}>
                    {file.viewPath ? (
                      <Link
                        className={`${styles.fileAction} ${styles.fileActionPrimary}`}
                        href={file.viewPath}
                      >
                        View
                      </Link>
                    ) : null}
                    <a className={styles.fileAction} href={file.downloadPath}>
                      Download
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
