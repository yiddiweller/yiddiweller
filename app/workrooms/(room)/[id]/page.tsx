import { notFound } from "next/navigation";

import WorkroomOverview from "@/components/workrooms/WorkroomOverview";
import { requireViewer } from "@/lib/client-auth/guard";
import { listActivity } from "@/lib/db/activity";
import { filesForViewer } from "@/lib/db/files";
import { presentationsForViewer } from "@/lib/db/presentations";
import { workroomForViewer, workroomPeople, workroomsForViewer } from "@/lib/db/workrooms";
import { projectDatesFor } from "@/lib/db/projects";
import { toClientFiles } from "@/lib/workrooms/delivery-view";
import { toClientActivity, toClientPeople, toClientWorkroomView } from "@/lib/workrooms/view";

/**
 * One Workroom.
 *
 * `requireViewer` runs here, before the first read, and every read carries the
 * membership — so a request from somebody who is not a member never fetches the
 * row. A Workroom that exists and one that never did produce the same 404,
 * because "you do not have access to Acme's rebrand" tells a stranger that
 * Acme's rebrand exists.
 *
 * Everything on the page comes through a projection. A database row is never
 * spread into `WorkroomOverview`, which is the same component the staff preview
 * renders — so the preview cannot drift from the thing it previews.
 */
export default async function Workroom({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;

  const room = await workroomForViewer(viewer.contactId, id);
  if (!room) notFound();

  const [people, activity, dates, others, files, presentations] = await Promise.all([
    workroomPeople(room.id),
    listActivity(room.id),
    projectDatesFor(room.projectId),
    workroomsForViewer(viewer.contactId),
    filesForViewer(viewer.contactId, id),
    presentationsForViewer(viewer.contactId, id),
  ]);

  return (
    <WorkroomOverview
      view={toClientWorkroomView(room, dates)}
      people={toClientPeople(people)}
      files={toClientFiles(files, id)}
      presentations={presentations}
      timeline={toClientActivity(activity)}
      otherRooms={others.length}
    />
  );
}
