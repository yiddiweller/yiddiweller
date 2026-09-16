import { label } from "../business.ts";
import { type ActivityRow } from "../db/activity.ts";
import { type WorkroomPerson, type WorkroomRow } from "../db/workrooms.ts";

/**
 * The only shape that reaches a client surface.
 *
 * **A whitelist, not a filter.** Every field a client sees is named here, and a
 * database row is never spread into a client component — hiding a field in the
 * markup leaves it in the response, and Build 003 learned what that costs when
 * a record's name travelled inside a 307. Adding something to a Workroom page
 * means adding it here first, deliberately, in review.
 *
 * What is deliberately absent, and never fetched on a client request:
 * `clients.notes`, `contacts.notes`, `projects.notes`, `projects.description`,
 * anything about Leads, anything from `audit_events`, other Workrooms, other
 * Contacts, and every internal id except the Workroom's own opaque one.
 *
 * `projects.description` is excluded even though it describes the work. It is
 * written by the studio for the studio, and "it is probably fine" is not a
 * privacy model. `workrooms.summary` is the field written for the client.
 */

export type ClientWorkroomView = {
  /** The opaque URL id. The only identifier a client ever receives. */
  id: string;
  title: string;
  summary: string;
  clientName: string;
  projectName: string;
  /** A word, not the enum value. */
  status: string;
  startsOn: string | null;
  targetOn: string | null;
};

export type ClientActivityItem = {
  id: string;
  occurredAt: string;
  /** Already written out. The client never receives the vocabulary value. */
  text: string;
};

export function toClientWorkroomView(
  row: WorkroomRow,
  dates: { startsOn: string | null; targetOn: string | null },
): ClientWorkroomView {
  return {
    id: row.publicId,
    title: row.title,
    summary: row.summary,
    clientName: row.clientName,
    projectName: row.projectName,
    status: label(row.projectStatus),
    startsOn: dates.startsOn,
    targetOn: dates.targetOn,
  };
}

export function toClientPeople(people: WorkroomPerson[]): { name: string; role: string | null }[] {
  return people.map((person) => ({ name: person.name, role: person.role }));
}

/**
 * Activity, written out on the server so the vocabulary never reaches the page.
 *
 * A client reads a sentence; they do not receive `project.status_changed` and a
 * mapping table to turn it into one.
 */
export function toClientActivity(rows: ActivityRow[]): ClientActivityItem[] {
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    text: sentence(row),
  }));
}

function sentence(row: ActivityRow): string {
  switch (row.kind) {
    case "workroom.opened":
      return "Workroom opened";
    case "workroom.joined":
      return `${row.actorLabel ?? "Someone"} joined`;
    case "workroom.access_granted":
      return `${row.subject ?? "Someone"} was given access`;
    case "workroom.access_ended":
      return `${row.subject ?? "Someone"}'s access ended`;
    case "project.status_changed":
      return `Status changed to ${row.subject ?? "something else"}`;
  }
}
