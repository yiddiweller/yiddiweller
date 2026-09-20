import Link from "next/link";
import { notFound } from "next/navigation";

import PresentationView from "@/components/workrooms/PresentationView";
import ReviewPanel from "@/app/studio/(app)/workrooms/[id]/presentations/ReviewPanel";
import { requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { findPresentation, listRevisions, revisionForStaff } from "@/lib/db/presentations";
import { findWorkroom } from "@/lib/db/workrooms";
import studio from "@/app/studio/studio.module.css";
import styles from "@/app/workrooms/workroom.module.css";

export const metadata = { title: "Version" };

/**
 * One published version, exactly as the client received it.
 *
 * Rendered from that Revision's own frozen snapshot through the same component
 * the client reads it with — never rebuilt from the draft, which is the whole
 * point of freezing one. The content hash is shown because this is the page
 * where somebody asks *is this really what they saw*, and it is the answer.
 */
export default async function StudioPresentationRevision({
  params,
}: {
  params: Promise<{ id: string; pid: string; n: string }>;
}) {
  const staff = await requireStaff();
  const { id, pid, n } = await params;
  if (!isId(id) || !isId(pid)) notFound();
  if (!/^[1-9][0-9]{0,8}$/.test(n)) notFound();

  const [room, presentation] = await Promise.all([findWorkroom(id), findPresentation(pid)]);
  if (!room || !presentation || presentation.workroomId !== room.id) notFound();

  const number = Number(n);
  const [view, revisions] = await Promise.all([
    revisionForStaff(presentation, number),
    listRevisions(presentation.id),
  ]);
  if (!view) notFound();

  const revision = revisions.find((entry) => entry.revisionNumber === number);

  return (
    <>
      <Link
        className={studio.back}
        href={`/studio/workrooms/${room.id}/presentations/${presentation.id}`}
      >
        ← {presentation.title}
      </Link>

      <div className={studio.notice}>
        <p className={studio.noticeTitle}>
          Version {number}, as published{revision?.publishedByName ? ` by ${revision.publishedByName}` : ""}.
        </p>
        <p>
          Frozen. Nothing edits this, including us — the database refuses an update, a delete and a
          truncate on it. Content hash <code>{revision?.contentHash.slice(0, 16)}…</code>
        </p>
      </div>

      <div className={`${styles.tokens} ${studio.section}`}>
        {/* The same history affordance the client has, pointing at Studio's
            own revision routes. Staff comparing two versions should not have
            to go back to a list — and it keeps this page structurally
            identical to the client's, which is what the parity test checks. */}
        <PresentationView
          presentation={view}
          revisionHref={(other) =>
            `/studio/workrooms/${room.id}/presentations/${presentation.id}/revisions/${other}`
          }
        />
      </div>

      {/* This version's own round, if it ever had one. A round belongs to the
          Revision it was asked about, so an older version keeps what was said
          about it — closed, because publishing a newer one closed it. */}
      <ReviewPanel
        staff={{ userId: staff.id }}
        workroomId={room.id}
        presentationId={presentation.id}
        revision={number}
        loadItems={async () => view.items}
      />
    </>
  );
}
