import Link from "next/link";
import { notFound } from "next/navigation";

import Moment from "@/components/studio/Moment";
import { requireViewer } from "@/lib/client-auth/guard";
import { presentationForViewer } from "@/lib/db/presentations";
import { workroomForViewer } from "@/lib/db/workrooms";
import { isPublicId } from "@/lib/workrooms/id";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * What was published, and when.
 *
 * Two facts and nothing about what changed. A client reading a changelog of the
 * studio's second thoughts is not the product; being able to go back and look
 * at what they were actually sent is.
 *
 * It reads through `presentationForViewer`, so this page is reachable on
 * exactly the terms the Presentation itself is — an unpublished Presentation
 * has no history page either.
 */
export default async function ClientRevisionHistory({
  params,
}: {
  params: Promise<{ id: string; pid: string }>;
}) {
  const viewer = await requireViewer();
  const { id, pid } = await params;
  if (!isPublicId(id) || !isPublicId(pid)) notFound();

  const [room, presentation] = await Promise.all([
    workroomForViewer(viewer.contactId, id),
    presentationForViewer(viewer.contactId, id, pid),
  ]);
  if (!room || !presentation) notFound();

  return (
    <>
      <p className={styles.eyebrow}>
        <Link className={styles.quiet} href={`/workrooms/${id}/presentations/${pid}`}>
          ← {presentation.title}
        </Link>
      </p>
      <h1 className={styles.display}>Versions</h1>

      <div className={styles.sections}>
        <section className={styles.section}>
          <ul>
            {presentation.revisions.map((entry) => (
              <li key={entry.number} className={styles.presentationRow}>
                <Link
                  className={styles.presentationRowTitle}
                  href={
                    entry.current
                      ? `/workrooms/${id}/presentations/${pid}`
                      : `/workrooms/${id}/presentations/${pid}/revisions/${entry.number}`
                  }
                >
                  Version {entry.number}
                </Link>
                <span className={styles.presentationRowMeta}>
                  <Moment iso={entry.publishedAt} />
                  {entry.current ? " · Current" : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
