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
 * a row. The title is static for the same reason every Workroom title is: a
 * refused request still produces one, and a title that names the work tells a
 * stranger the work exists.
 */
export const metadata = { title: "Files" };

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
                  <a className={styles.fileLink} href={file.downloadPath}>
                    {file.name}
                  </a>
                  <span className={styles.fileMeta}>
                    {file.kind} · {file.size}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
