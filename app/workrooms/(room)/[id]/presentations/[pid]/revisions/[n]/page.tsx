import Link from "next/link";
import { notFound } from "next/navigation";

import PresentationView from "@/components/workrooms/PresentationView";
import ReviewPanel from "@/app/workrooms/(room)/[id]/presentations/ReviewPanel";
import { requireViewer } from "@/lib/client-auth/guard";
import { presentationForViewer } from "@/lib/db/presentations";
import { workroomForViewer } from "@/lib/db/workrooms";
import { isPublicId } from "@/lib/workrooms/id";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * One earlier Revision, exactly as it was published.
 *
 * **A Revision row exists if and only if the publish transaction wrote it**, so
 * "may this client open Version 2?" is answered by the row existing inside the
 * same scope every other client read uses. No flag is consulted and none can be
 * got wrong; an unpublished Presentation takes its whole history with it.
 *
 * The number is read from the URL and passed as a number. Anything that is not
 * a positive integer is a 404 rather than a query — the same concealment every
 * other refusal here uses.
 */
export default async function ClientPresentationRevision({
  params,
}: {
  params: Promise<{ id: string; pid: string; n: string }>;
}) {
  const viewer = await requireViewer();
  const { id, pid, n } = await params;
  if (!isPublicId(id) || !isPublicId(pid)) notFound();

  if (!/^[1-9][0-9]{0,8}$/.test(n)) notFound();
  const revision = Number(n);

  const [room, presentation] = await Promise.all([
    workroomForViewer(viewer.contactId, id),
    presentationForViewer(viewer.contactId, id, pid, revision),
  ]);
  if (!room || !presentation) notFound();

  return (
    <>
      <p className={styles.eyebrow}>
        <Link className={styles.quiet} href={`/workrooms/${id}/presentations/${pid}`}>
          ← Latest version
        </Link>
      </p>

      <PresentationView
        presentation={presentation}
        revisionHref={(other) => `/workrooms/${id}/presentations/${pid}/revisions/${other}`}
      />

      {/* The round that belonged to *this* version, with whatever was said in
          it. Read-only, and not because history is special: publishing a newer
          version closed it, and a closed round takes nothing from anybody. */}
      <ReviewPanel
        viewer={{ contactId: viewer.contactId, identityId: viewer.id }}
        room={id}
        presentation={pid}
        items={presentation.items}
        revision={revision}
      />
    </>
  );
}
