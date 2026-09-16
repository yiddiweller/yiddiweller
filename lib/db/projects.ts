import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { label } from "../business.ts";
import { record, type AuditActor, changedFields } from "./audit.ts";
import { publishedWorkroomFor, recordProjectStatusForClients } from "./workrooms.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import {
  clients,
  contacts,
  projectContacts,
  projects,
  PROJECT_LIVE_STATUSES,
  user,
  type ProjectStatus,
} from "./schema.ts";

/**
 * Projects: the work. Always for a client — that is the one relationship the
 * database refuses to do without — and sometimes from a lead, when the work
 * began as an opportunity. The model is in docs/business-core.md.
 *
 * Dates here are days rather than instants: a project starts on a date, and
 * `starts_on` is a `date` column carrying `YYYY-MM-DD`, so nobody's timezone
 * can move it.
 */

export type Project = {
  id: string;
  clientId: string;
  leadId: string | null;
  name: string;
  status: ProjectStatus;
  description: string;
  notes: string;
  ownerId: string | null;
  startsOn: string | null;
  targetOn: string | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ProjectRow = Project & {
  clientName: string;
  ownerName: string | null;
};

export type ProjectInput = {
  clientId: string;
  name: string;
  status: ProjectStatus;
  description: string;
  notes: string;
  ownerId: string | null;
  startsOn: string | null;
  targetOn: string | null;
};

export type ProjectFilter = {
  query?: string;
  status?: ProjectStatus | null;
  clientId?: string | null;
  ownerId?: string | null;
  live?: boolean;
  archived?: "active" | "archived";
  page?: number;
  pageSize?: number;
};

export type ProjectContactRow = {
  id: string;
  role: string | null;
  isPrimary: boolean;
  version: number;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  contactTitle: string | null;
  contactArchived: boolean;
};

const columns = {
  id: projects.id,
  clientId: projects.clientId,
  leadId: projects.leadId,
  name: projects.name,
  status: projects.status,
  description: projects.description,
  notes: projects.notes,
  ownerId: projects.ownerId,
  startsOn: projects.startsOn,
  targetOn: projects.targetOn,
  version: projects.version,
  archivedAt: projects.archivedAt,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

function filterClause(filter: ProjectFilter): SQL | undefined {
  const where: SQL[] = [];

  where.push(
    filter.archived === "archived" ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
  );
  if (filter.status) where.push(eq(projects.status, filter.status));
  if (filter.live) where.push(inArray(projects.status, PROJECT_LIVE_STATUSES));
  if (filter.clientId) where.push(eq(projects.clientId, filter.clientId));
  if (filter.ownerId) where.push(eq(projects.ownerId, filter.ownerId));
  if (filter.query) {
    const like = `%${filter.query}%`;
    where.push(or(ilike(projects.name, like), ilike(clients.name, like)) as SQL);
  }

  return where.length > 0 ? and(...where) : undefined;
}

/**
 * The index. The client is joined rather than fetched per row, because a
 * project without the name of whose work it is reads as a list of anonymous
 * nouns.
 */
export async function listProjects(
  filter: ProjectFilter = {},
): Promise<{ rows: ProjectRow[]; total: number }> {
  const pageSize = filter.pageSize ?? 25;
  const page = filter.page ?? 1;
  const clause = filterClause(filter);

  const [rows, [total]] = await Promise.all([
    db()
      .select({ ...columns, clientName: clients.name, ownerName: user.name })
      .from(projects)
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .leftJoin(user, eq(user.id, projects.ownerId))
      .where(clause)
      .orderBy(desc(projects.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db()
      .select({ n: count() })
      .from(projects)
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(clause),
  ]);

  return { rows: rows as ProjectRow[], total: total?.n ?? 0 };
}

export async function findProject(id: string): Promise<ProjectRow | null> {
  const [row] = await db()
    .select({ ...columns, clientName: clients.name, ownerName: user.name })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .leftJoin(user, eq(user.id, projects.ownerId))
    .where(eq(projects.id, id))
    .limit(1);
  return (row as ProjectRow | undefined) ?? null;
}

export async function createProject(
  actor: AuditActor,
  input: ProjectInput,
): Promise<Outcome<string>> {
  const [client] = await db()
    .select({ name: clients.name, archivedAt: clients.archivedAt })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1);

  if (!client) return refuse("not_found", "That client no longer exists.");
  if (client.archivedAt) {
    return refuse("blocked", `${client.name} is archived. Restore the client before adding work.`);
  }

  const id = uuidv7();
  await db().transaction(async (tx) => {
    await insertProject(tx, actor, id, input);
  });

  return ok(id);
}

/**
 * The insert on its own, so converting a lead writes the same row and the same
 * audit event inside the conversion's transaction rather than reimplementing
 * both. `leadId` is set only by that path.
 */
export async function insertProject(
  tx: Tx,
  actor: AuditActor,
  id: string,
  input: ProjectInput & { leadId?: string | null },
): Promise<void> {
  await tx.insert(projects).values({ ...input, id, createdBy: actor.id, updatedBy: actor.id });
  await record(tx, actor, {
    action: "project.created",
    entityType: "project",
    entityId: id,
    entityLabel: input.name,
    metadata: { client_id: input.clientId, status: input.status, from_lead: Boolean(input.leadId) },
  });
}

/**
 * The client a project belongs to is deliberately not editable here. Work moved
 * to a different client is different work, and quietly reassigning it would
 * rewrite what the audit log already said about the old one.
 */
export async function updateProject(
  actor: AuditActor,
  id: string,
  input: Omit<ProjectInput, "clientId">,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const before = await findProject(id);
  if (!before) return refuse("not_found", "That project no longer exists.");

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(projects)
      .set({ ...input, updatedBy: actor.id })
      .where(and(eq(projects.id, id), eq(projects.version, expectedVersion)))
      .returning({ id: projects.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "project.updated",
      entityType: "project",
      entityId: id,
      entityLabel: input.name,
      // The names of what changed, never the values. See docs/audit.md.
      metadata: {
        fields: changedFields(before as unknown as Record<string, unknown>, input),
        status: input.status,
      },
    });

    // One business event, two records with different content: the audit entry
    // above carries the actor and the field names, and this carries the status
    // and nothing else. See docs/activity.md.
    if (before.status !== input.status) {
      await recordProjectStatusForClients(tx, id, label(input.status));
    }

    return ok(undefined);
  });
}

/**
 * Archiving live work is refused. Archive means "put away", and putting away a
 * project that is still planned, active or on hold hides work somebody is
 * expecting. Complete it or cancel it first — both are one field away.
 */
export async function archiveProject(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const project = await findProject(id);
  if (!project) return refuse("not_found", "That project no longer exists.");
  if (project.archivedAt) return ok(undefined);

  if ((PROJECT_LIVE_STATUSES as readonly string[]).includes(project.status)) {
    return refuse(
      "blocked",
      `${project.name} is still live. Mark it completed or cancelled before archiving it.`,
    );
  }

  // A client can still open a published workroom, and archiving the work behind
  // one would leave them looking at a project the studio has put away.
  const open = await publishedWorkroomFor(id);
  if (open) {
    return refuse(
      "blocked",
      `${open} is open to its members. Unpublish the workroom first, so nobody loses access by accident.`,
    );
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(projects)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(projects.id, id), eq(projects.version, expectedVersion)))
      .returning({ id: projects.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "project.archived",
      entityType: "project",
      entityId: id,
      entityLabel: project.name,
    });
    return ok(undefined);
  });
}

/**
 * Restoring is refused while the client is archived, because work in
 * circulation for a client that is not would appear in the lists with nowhere
 * to open from. Restore the client first.
 */
export async function restoreProject(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const project = await findProject(id);
  if (!project) return refuse("not_found", "That project no longer exists.");
  if (!project.archivedAt) return ok(undefined);

  const [client] = await db()
    .select({ name: clients.name, archivedAt: clients.archivedAt })
    .from(clients)
    .where(eq(clients.id, project.clientId))
    .limit(1);

  if (client?.archivedAt) {
    return refuse("blocked", `${client.name} is archived. Restore the client first.`);
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(projects)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(projects.id, id), eq(projects.version, expectedVersion)))
      .returning({ id: projects.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "project.restored",
      entityType: "project",
      entityId: id,
      entityLabel: project.name,
    });
    return ok(undefined);
  });
}

/**
 * Live work whose target date has passed. A real condition, read from the row
 * rather than from anybody remembering to flag it.
 *
 * `target_on` is a date, so the comparison is against today's date in UTC —
 * which is the same day for everybody until the small hours, and a day either
 * way on an overdue project is not a decision anybody makes.
 */
export async function overdueProjects(today: string, limit = 5): Promise<ProjectRow[]> {
  return (await db()
    .select({ ...columns, clientName: clients.name, ownerName: user.name })
    .from(projects)
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .leftJoin(user, eq(user.id, projects.ownerId))
    .where(
      and(
        isNull(projects.archivedAt),
        inArray(projects.status, PROJECT_LIVE_STATUSES),
        isNotNull(projects.targetOn),
        lt(projects.targetOn, today),
      ),
    )
    .orderBy(asc(projects.targetOn))
    .limit(limit)) as ProjectRow[];
}

/** How much work is live right now. */
export async function countLiveProjects(): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(projects)
    .where(and(isNull(projects.archivedAt), inArray(projects.status, PROJECT_LIVE_STATUSES)));
  return row?.n ?? 0;
}

/**
 * The two dates a client is shown, and nothing else from the project.
 *
 * A separate, deliberately tiny read rather than handing the whole project row
 * to the client surface: `description` and `notes` are written by the studio
 * for the studio, and the safest way not to leak them is not to fetch them.
 */
export async function projectDatesFor(
  projectId: string,
): Promise<{ startsOn: string | null; targetOn: string | null }> {
  const [row] = await db()
    .select({ startsOn: projects.startsOn, targetOn: projects.targetOn })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  return row ?? { startsOn: null, targetOn: null };
}

/* ------------------------------------------------------ project ↔ contact */

/**
 * The same shape as the client relationship in `contacts.ts`, and deliberately
 * written out rather than shared: the two link tables point at different
 * parents, and a version generic enough to cover both would need casts that
 * defeat the types that make either one safe.
 */
export async function projectContactRows(projectId: string): Promise<ProjectContactRow[]> {
  return db()
    .select({
      id: projectContacts.id,
      role: projectContacts.role,
      isPrimary: projectContacts.isPrimary,
      version: projectContacts.version,
      contactId: contacts.id,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactTitle: contacts.title,
      contactArchived: sql<boolean>`(${contacts.archivedAt} IS NOT NULL)`,
    })
    .from(projectContacts)
    .innerJoin(contacts, eq(contacts.id, projectContacts.contactId))
    .where(eq(projectContacts.projectId, projectId))
    .orderBy(desc(projectContacts.isPrimary), asc(contacts.name))
    .limit(200);
}

export async function attachContactToProject(
  actor: AuditActor,
  input: { projectId: string; contactId: string; role: string | null; isPrimary: boolean },
): Promise<Outcome<string>> {
  const [project] = await db()
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) return refuse("not_found", "That project no longer exists.");

  const [contact] = await db()
    .select({ name: contacts.name })
    .from(contacts)
    .where(eq(contacts.id, input.contactId))
    .limit(1);
  if (!contact) return refuse("not_found", "That contact no longer exists.");

  return db().transaction(async (tx) => {
    // Clearing first, because at most one primary per project is a unique index
    // and the insert would be refused rather than take over.
    if (input.isPrimary) {
      await tx
        .update(projectContacts)
        .set({ isPrimary: false })
        .where(
          and(eq(projectContacts.projectId, input.projectId), eq(projectContacts.isPrimary, true)),
        );
    }

    const id = uuidv7();
    const inserted = await tx
      .insert(projectContacts)
      .values({ ...input, id, createdBy: actor.id })
      .onConflictDoNothing({ target: [projectContacts.projectId, projectContacts.contactId] })
      .returning({ id: projectContacts.id });

    if (inserted.length === 0) {
      return refuse<string>(
        "already_done",
        `${contact.name} is already listed on ${project.name}.`,
      );
    }

    await record(tx, actor, {
      action: "project_contact.attached",
      entityType: "project_contact",
      entityId: id,
      entityLabel: `${contact.name} → ${project.name}`,
      metadata: {
        project_id: input.projectId,
        contact_id: input.contactId,
        primary: input.isPrimary,
      },
    });

    return ok(id);
  });
}

export async function updateProjectContact(
  actor: AuditActor,
  id: string,
  input: { role: string | null; isPrimary: boolean },
  expectedVersion: number,
): Promise<Outcome<void>> {
  const [row] = await db()
    .select({
      projectId: projectContacts.projectId,
      projectName: projects.name,
      contactName: contacts.name,
    })
    .from(projectContacts)
    .innerJoin(projects, eq(projects.id, projectContacts.projectId))
    .innerJoin(contacts, eq(contacts.id, projectContacts.contactId))
    .where(eq(projectContacts.id, id))
    .limit(1);

  if (!row) return refuse("not_found", "That relationship no longer exists.");

  return db().transaction(async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(projectContacts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(projectContacts.projectId, row.projectId),
            eq(projectContacts.isPrimary, true),
            ne(projectContacts.id, id),
          ),
        );
    }

    const changed = await tx
      .update(projectContacts)
      .set(input)
      .where(and(eq(projectContacts.id, id), eq(projectContacts.version, expectedVersion)))
      .returning({ id: projectContacts.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "project_contact.updated",
      entityType: "project_contact",
      entityId: id,
      entityLabel: `${row.contactName} → ${row.projectName}`,
      metadata: { primary: input.isPrimary },
    });

    return ok(undefined);
  });
}

/** Removes the relationship, not the person. See `detachContactFromClient`. */
export async function detachContactFromProject(
  actor: AuditActor,
  id: string,
): Promise<Outcome<void>> {
  const [row] = await db()
    .select({ projectName: projects.name, contactName: contacts.name })
    .from(projectContacts)
    .innerJoin(projects, eq(projects.id, projectContacts.projectId))
    .innerJoin(contacts, eq(contacts.id, projectContacts.contactId))
    .where(eq(projectContacts.id, id))
    .limit(1);

  if (!row) return ok(undefined);

  return db().transaction(async (tx) => {
    await tx.delete(projectContacts).where(eq(projectContacts.id, id));
    await record(tx, actor, {
      action: "project_contact.detached",
      entityType: "project_contact",
      entityId: id,
      entityLabel: `${row.contactName} → ${row.projectName}`,
    });
    return ok(undefined);
  });
}
