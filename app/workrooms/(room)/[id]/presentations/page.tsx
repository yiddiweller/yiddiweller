import Link from "next/link";
import { notFound } from "next/navigation";

import Moment from "@/components/studio/Moment";
import { requireViewer } from "@/lib/client-auth/guard";
import { presentationsForViewer } from "@/lib/db/presentations";
import { workroomForViewer } from "@/lib/db/workrooms";
import { isPublicId } from "@/lib/workrooms/id";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * Everything the studio has presented in this Workroom.
 *
 * `requireViewer` runs here, inside the component, before the first read, and
 * `presentationsForViewer` carries membership, the Workroom's published state
 * and the Presentation's own in one `WHERE`. There is no `loading.tsx` above
 * it: a Suspense boundary over a guarded page turns a refusal into a 200.
 *
 * Like every page under `/workrooms`, it sets no title — they all inherit the
 * layout's generic "Workroom", so a title says nothing about the work and
 * nothing about which page somebody is on.
 */
export default async function ClientPresentations({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireViewer();
  const { id } = await params;
  if (!isPublicId(id)) notFound();

  const room = await workroomForViewer(viewer.contactId, id);
  if (!room) notFound();

  const presentations = await presentationsForViewer(viewer.contactId, id);

  return (
    <>
      <p className={styles.eyebrow}>
        <Link className={styles.quiet} href={`/workrooms/${id}`}>
          ← {room.title}
        </Link>
      </p>
      <h1 className={styles.display}>Presentations</h1>

      <div className={styles.sections}>
        <section className={styles.section}>
          {presentations.length === 0 ? (
            <p className={styles.empty}>
              Nothing has been presented yet. Work will appear here as it is ready to show.
            </p>
          ) : (
            <ul>
              {presentations.map((presentation) => (
                <li key={presentation.id} className={styles.presentationRow}>
                  <Link
                    className={styles.presentationRowTitle}
                    href={`/workrooms/${id}/presentations/${presentation.id}`}
                  >
                    {presentation.title}
                  </Link>
                  <span className={styles.presentationRowMeta}>
                    <Moment iso={presentation.publishedAt} />
                    {/* The version number only once there is more than one.
                        "Version 1" is a fact about our software, not the work. */}
                    {presentation.revisionCount > 1 ? ` · Version ${presentation.revision}` : ""}
                  </span>
                  {presentation.intro ? (
                    <span className={styles.presentationRowIntro}>{presentation.intro}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
