import Link from "next/link";
import { notFound } from "next/navigation";

import PresentationView from "@/components/workrooms/PresentationView";
import { requireViewer } from "@/lib/client-auth/guard";
import { presentationForViewer } from "@/lib/db/presentations";
import { workroomForViewer } from "@/lib/db/workrooms";
import { isPublicId } from "@/lib/workrooms/id";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * The current Revision of one Presentation.
 *
 * What renders is the frozen snapshot that Revision holds, never the studio's
 * draft — so a member of staff editing without republishing changes what they
 * see in Preview and changes nothing here.
 */
export default async function ClientPresentation({
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
        <Link className={styles.quiet} href={`/workrooms/${id}/presentations`}>
          ← Presentations
        </Link>
      </p>

      <PresentationView
        presentation={presentation}
        revisionHref={(revision) => `/workrooms/${id}/presentations/${pid}/revisions/${revision}`}
      />
    </>
  );
}
