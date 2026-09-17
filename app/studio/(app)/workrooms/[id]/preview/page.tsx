import Link from "next/link";
import { notFound } from "next/navigation";

import WorkroomOverview from "@/components/workrooms/WorkroomOverview";
import { requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { listActivity } from "@/lib/db/activity";
import { sharedFilesInWorkroom } from "@/lib/db/files";
import { projectDatesFor } from "@/lib/db/projects";
import { findWorkroom, workroomPeople } from "@/lib/db/workrooms";
import { toClientFiles } from "@/lib/workrooms/delivery-view";
import { toClientActivity, toClientPeople, toClientWorkroomView } from "@/lib/workrooms/view";
import studio from "@/app/studio/studio.module.css";
import styles from "@/app/workrooms/workroom.module.css";

export const metadata = { title: "Preview" };

/**
 * What the client sees, seen from Studio.
 *
 * It renders `WorkroomOverview` — **the same component the client's own page
 * renders**, not a copy of it. That is what makes the sentence on the page
 * true. It was not always: Build 005 added a Files section to the client's page
 * and left this one behind, so a shared file appeared in a client's Workroom
 * and was invisible to the person checking their work. Nothing failed; the
 * preview simply showed an older product, which is the worst way for a
 * verification surface to be wrong.
 *
 * The one thing that differs is *how the data is fetched*, and it has to: there
 * is no client session here, so there is no membership to scope by. The
 * visibility rules are not restated — `sharedFilesInWorkroom` shares its
 * predicate with the client's own read, so ready, shared and unarchived mean
 * the same thing in both places.
 *
 * It is a staff-authorized Studio route. It issues no client session, is not a
 * URL a client could discover, and there is no "sign in as this client"
 * anywhere in the product. Staff authority is staff authority; it is not a way
 * to become somebody else.
 */
export default async function WorkroomPreview({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const room = await findWorkroom(id);
  if (!room) notFound();

  const [people, activity, dates, files] = await Promise.all([
    workroomPeople(room.id),
    listActivity(room.id),
    projectDatesFor(room.projectId),
    sharedFilesInWorkroom(room.id),
  ]);

  return (
    <>
      <Link className={studio.back} href={`/studio/workrooms/${room.id}`}>
        ← {room.title}
      </Link>

      <div className={studio.notice}>
        <p className={studio.noticeTitle}>This is the client&rsquo;s view.</p>
        <p>
          The same component and the same projection the real page uses, so nothing here is a
          mock-up. Nobody outside the studio can reach this address.
        </p>
      </div>

      <div className={`${styles.tokens} ${studio.section}`}>
        <WorkroomOverview
          view={toClientWorkroomView(room, dates)}
          people={toClientPeople(people)}
          files={toClientFiles(files, room.publicId)}
          timeline={toClientActivity(activity)}
          /* The preview is always of one Workroom, so the "your workrooms" link
             is never shown here — it would be a link out of the preview. */
          otherRooms={1}
        />
      </div>
    </>
  );
}
