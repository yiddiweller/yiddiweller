import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { record as recordActivity } from "./activity.ts";
import { record as recordAudit, type AuditActor } from "./audit.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import {
  clientContacts,
  clientIdentity,
  clients,
  contacts,
  projects,
  workroomInvitations,
  workroomMembers,
  workrooms,
  type WorkroomStatus,
} from "./schema.ts";
import { log, redactEmail } from "../log.ts";
import { workroomPublicId } from "../workrooms/id.ts";

/**
 * Workrooms: the private place a client is given for one piece of work.
 *
 * Everything that grants, refuses or removes client access goes through this
 * module, in a transaction, with its audit event and — where the client should
 * see it — its activity event written alongside. The model is in
 * docs/workrooms.md and the identity half is in docs/client-auth.md.
 *
 * Two rules run through all of it:
 *
 *   access is explicit    being a Contact at the Client grants nothing
 *   reads are whitelists  nothing reaches a client except through
 *                         `lib/workrooms/view.ts`
 */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tokens are stored as a digest, so a database read yields no usable link. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------------ types */

export type Workroom = {
  id: string;
  publicId: string;
  projectId: string;
  title: string;
  summary: string;
  status: WorkroomStatus;
  publishedAt: Date | null;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkroomRow = Workroom & {
  projectName: string;
  projectStatus: string;
  clientId: string;
  clientName: string;
  memberCount: number;
};

export type WorkroomMemberRow = {
  id: string;
  version: number;
  status: "active" | "revoked";
  grantedAt: Date;
  revokedAt: Date | null;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  /** The verified access email, when they have signed in. Never the contact's. */
  accessEmail: string | null;
  identityId: string | null;
  identityStatus: string | null;
};

export type WorkroomInvitationRow = {
  id: string;
  email: string;
  expiresAt: Date;
  createdAt: Date;
  expired: boolean;
  contactId: string;
  contactName: string;
};

const columns = {
  id: workrooms.id,
  publicId: workrooms.publicId,
  projectId: workrooms.projectId,
  title: workrooms.title,
  summary: workrooms.summary,
  status: workrooms.status,
  publishedAt: workrooms.publishedAt,
  version: workrooms.version,
  archivedAt: workrooms.archivedAt,
  createdAt: workrooms.createdAt,
  updatedAt: workrooms.updatedAt,
};

/** The Client is one join away, deliberately: see docs/workrooms.md. */
function joined() {
  return db()
    .select({
      ...columns,
      projectName: projects.name,
      projectStatus: projects.status,
      clientId: clients.id,
      clientName: clients.name,
      memberCount: sql<number>`(
        SELECT count(*)::int FROM workroom_members m
        WHERE m.workroom_id = workrooms.id AND m.status = 'active'
      )`,
    })
    .from(workrooms)
    .innerJoin(projects, eq(projects.id, workrooms.projectId))
    .innerJoin(clients, eq(clients.id, projects.clientId));
}

/* ------------------------------------------------------------ staff reads */

export type WorkroomFilter = {
  query?: string;
  status?: WorkroomStatus | null;
  archived?: "active" | "archived";
  page?: number;
  pageSize?: number;
};

export async function listWorkrooms(
  filter: WorkroomFilter = {},
): Promise<{ rows: WorkroomRow[]; total: number }> {
  const pageSize = filter.pageSize ?? 25;
  const page = filter.page ?? 1;

  const where: SQL[] = [
    filter.archived === "archived" ? isNotNull(workrooms.archivedAt) : isNull(workrooms.archivedAt),
  ];
  if (filter.status) where.push(eq(workrooms.status, filter.status));
  if (filter.query) {
    const like = `%${filter.query}%`;
    where.push(
      or(ilike(workrooms.title, like), ilike(projects.name, like), ilike(clients.name, like)) as SQL,
    );
  }
  const clause = and(...where);

  const [rows, [total]] = await Promise.all([
    joined().where(clause).orderBy(desc(workrooms.updatedAt)).limit(pageSize).offset((page - 1) * pageSize),
    db()
      .select({ n: count() })
      .from(workrooms)
      .innerJoin(projects, eq(projects.id, workrooms.projectId))
      .innerJoin(clients, eq(clients.id, projects.clientId))
      .where(clause),
  ]);

  return { rows: rows as WorkroomRow[], total: total?.n ?? 0 };
}

export async function findWorkroom(id: string): Promise<WorkroomRow | null> {
  const [row] = await joined().where(eq(workrooms.id, id)).limit(1);
  return (row as WorkroomRow | undefined) ?? null;
}

/** The Workroom a Project has, if it has one. Used by the Project page. */
export async function workroomForProject(projectId: string): Promise<WorkroomRow | null> {
  const [row] = await joined().where(eq(workrooms.projectId, projectId)).limit(1);
  return (row as WorkroomRow | undefined) ?? null;
}

export async function listWorkroomMembers(workroomId: string): Promise<WorkroomMemberRow[]> {
  const rows = await db()
    .select({
      id: workroomMembers.id,
      version: workroomMembers.version,
      status: workroomMembers.status,
      grantedAt: workroomMembers.grantedAt,
      revokedAt: workroomMembers.revokedAt,
      contactId: contacts.id,
      contactName: contacts.name,
      contactEmail: contacts.email,
      accessEmail: clientIdentity.email,
      identityId: clientIdentity.id,
      identityStatus: clientIdentity.status,
    })
    .from(workroomMembers)
    .innerJoin(contacts, eq(contacts.id, workroomMembers.contactId))
    .leftJoin(clientIdentity, eq(clientIdentity.contactId, contacts.id))
    .where(eq(workroomMembers.workroomId, workroomId))
    .orderBy(desc(workroomMembers.status), asc(contacts.name))
    .limit(200);

  return rows as WorkroomMemberRow[];
}

/** Invitations that have not been accepted or revoked. Expired ones still show. */
export async function listOpenInvitations(workroomId: string): Promise<WorkroomInvitationRow[]> {
  const now = new Date();
  const rows = await db()
    .select({
      id: workroomInvitations.id,
      email: workroomInvitations.email,
      expiresAt: workroomInvitations.expiresAt,
      createdAt: workroomInvitations.createdAt,
      contactId: contacts.id,
      contactName: contacts.name,
    })
    .from(workroomInvitations)
    .innerJoin(contacts, eq(contacts.id, workroomInvitations.contactId))
    .where(
      and(
        eq(workroomInvitations.workroomId, workroomId),
        isNull(workroomInvitations.acceptedAt),
        isNull(workroomInvitations.revokedAt),
      ),
    )
    .orderBy(desc(workroomInvitations.createdAt))
    .limit(100);

  return rows.map((row) => ({ ...row, expired: row.expiresAt.getTime() <= now.getTime() }));
}

export type InvitableContact = {
  id: string;
  name: string;
  email: string | null;
  /** The address an invitation would actually go to. See docs/client-auth.md. */
  accessEmail: string | null;
  reason: "client" | "project";
};

/**
 * Who staff may invite: a canonical Contact, not a typed address.
 *
 * Restricted to people already related to the Workroom's Client or Project,
 * because Build 003 owns who a person is and Build 004 owns what they can
 * reach. If somebody is not here yet, they are created as a Contact first —
 * one deliberate extra step, so the business record exists before the access.
 */
export async function invitableContacts(workroomId: string): Promise<InvitableContact[]> {
  const workroom = await findWorkroom(workroomId);
  if (!workroom) return [];

  const rows = await db()
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      accessEmail: clientIdentity.email,
      viaClient: sql<boolean>`EXISTS (
        SELECT 1 FROM client_contacts cc
        WHERE cc.contact_id = contacts.id AND cc.client_id = ${workroom.clientId}
      )`,
    })
    .from(contacts)
    .leftJoin(clientIdentity, eq(clientIdentity.contactId, contacts.id))
    .where(
      and(
        isNull(contacts.archivedAt),
        isNotNull(contacts.email),
        or(
          sql`EXISTS (SELECT 1 FROM client_contacts cc WHERE cc.contact_id = contacts.id AND cc.client_id = ${workroom.clientId})`,
          sql`EXISTS (SELECT 1 FROM project_contacts pc WHERE pc.contact_id = contacts.id AND pc.project_id = ${workroom.projectId})`,
        ) as SQL,
        // Somebody who already has access is not invitable again.
        sql`NOT EXISTS (
          SELECT 1 FROM workroom_members m
          WHERE m.contact_id = contacts.id AND m.workroom_id = ${workroomId} AND m.status = 'active'
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM workroom_invitations i
          WHERE i.contact_id = contacts.id AND i.workroom_id = ${workroomId}
            AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        )`,
      ),
    )
    .orderBy(asc(contacts.name))
    .limit(200);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    accessEmail: row.accessEmail,
    reason: row.viaClient ? "client" : "project",
  }));
}

/* ----------------------------------------------------------- staff writes */

export async function createWorkroom(
  actor: AuditActor,
  input: { projectId: string; title: string; summary: string },
): Promise<Outcome<string>> {
  const [project] = await db()
    .select({ id: projects.id, name: projects.name, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);

  if (!project) return refuse("not_found", "That project no longer exists.");
  if (project.archivedAt) {
    return refuse("blocked", `${project.name} is archived. Restore it before opening a workroom.`);
  }

  const id = uuidv7();
  const publicId = workroomPublicId();

  try {
    await db().transaction(async (tx) => {
      await tx.insert(workrooms).values({
        id,
        publicId,
        projectId: input.projectId,
        title: input.title,
        summary: input.summary,
        createdBy: actor.id,
        updatedBy: actor.id,
      });
      await recordAudit(tx, actor, {
        action: "workroom.created",
        entityType: "workroom",
        entityId: id,
        entityLabel: input.title,
        metadata: { project_id: input.projectId },
      });
    });
  } catch (error) {
    // One Workroom per Project is a unique index rather than a read both of
    // two simultaneous presses could pass.
    if (describes(error, "workrooms_project_id_idx")) {
      return refuse("already_done", `${project.name} already has a workroom.`);
    }
    throw error;
  }

  return ok(id);
}

function describes(error: unknown, needle: string): boolean {
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    if (current.message.includes(needle)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

export async function updateWorkroom(
  actor: AuditActor,
  id: string,
  input: { title: string; summary: string },
  expectedVersion: number,
): Promise<Outcome<void>> {
  const before = await findWorkroom(id);
  if (!before) return refuse("not_found", "That workroom no longer exists.");

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workrooms)
      .set({ ...input, updatedBy: actor.id })
      .where(and(eq(workrooms.id, id), eq(workrooms.version, expectedVersion)))
      .returning({ id: workrooms.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom.updated",
      entityType: "workroom",
      entityId: id,
      entityLabel: input.title,
      // The names of what changed, never the values.
      metadata: {
        fields: [
          before.title !== input.title ? "title" : null,
          before.summary !== input.summary ? "summary" : null,
        ].filter(Boolean),
      },
    });

    return ok(undefined);
  });
}

/**
 * Opening a Workroom to its members. Deliberate, audited, and the first thing
 * the client's own timeline records.
 */
export async function publishWorkroom(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const workroom = await findWorkroom(id);
  if (!workroom) return refuse("not_found", "That workroom no longer exists.");
  if (workroom.archivedAt) return refuse("blocked", "Restore this workroom before publishing it.");
  if (workroom.status === "published") return ok(undefined);

  const [project] = await db()
    .select({ archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.id, workroom.projectId))
    .limit(1);
  if (project?.archivedAt) {
    return refuse("blocked", "That project is archived. Restore it before publishing.");
  }

  const now = new Date();
  const first = workroom.publishedAt === null;

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workrooms)
      .set({
        status: "published",
        publishedAt: workroom.publishedAt ?? now,
        updatedBy: actor.id,
      })
      .where(and(eq(workrooms.id, id), eq(workrooms.version, expectedVersion)))
      .returning({ id: workrooms.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom.published",
      entityType: "workroom",
      entityId: id,
      entityLabel: workroom.title,
    });
    if (first) await recordActivity(tx, id, { kind: "workroom.opened" });

    return ok(undefined);
  });
}

export async function unpublishWorkroom(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const workroom = await findWorkroom(id);
  if (!workroom) return refuse("not_found", "That workroom no longer exists.");
  if (workroom.status !== "published") return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workrooms)
      .set({ status: "unpublished", updatedBy: actor.id })
      .where(and(eq(workrooms.id, id), eq(workrooms.version, expectedVersion)))
      .returning({ id: workrooms.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom.unpublished",
      entityType: "workroom",
      entityId: id,
      entityLabel: workroom.title,
    });
    return ok(undefined);
  });
}

/**
 * Archiving is refused while the workroom is published, so losing client
 * access is never a side effect of tidying up.
 */
export async function archiveWorkroom(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const workroom = await findWorkroom(id);
  if (!workroom) return refuse("not_found", "That workroom no longer exists.");
  if (workroom.archivedAt) return ok(undefined);
  if (workroom.status === "published") {
    return refuse(
      "blocked",
      `${workroom.title} is open to its members. Unpublish it first, so nobody loses access by accident.`,
    );
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workrooms)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(workrooms.id, id), eq(workrooms.version, expectedVersion)))
      .returning({ id: workrooms.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom.archived",
      entityType: "workroom",
      entityId: id,
      entityLabel: workroom.title,
    });
    return ok(undefined);
  });
}

export async function restoreWorkroom(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const workroom = await findWorkroom(id);
  if (!workroom) return refuse("not_found", "That workroom no longer exists.");
  if (!workroom.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workrooms)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(workrooms.id, id), eq(workrooms.version, expectedVersion)))
      .returning({ id: workrooms.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom.restored",
      entityType: "workroom",
      entityId: id,
      entityLabel: workroom.title,
    });
    return ok(undefined);
  });
}

/* ------------------------------------------------------------ invitations */

export type IssuedInvitation = { id: string; token: string; email: string; expiresAt: Date };

/**
 * Invites one Contact to one Workroom.
 *
 * The address is chosen here, not by the caller, and that choice is the
 * security-relevant part: where the person already has a client identity, the
 * link goes to their **verified** access email rather than to whatever the
 * contact record says today. Otherwise an ordinary CRM edit would redirect
 * somebody's access to a different mailbox. See docs/client-auth.md.
 */
export async function inviteToWorkroom(
  actor: AuditActor,
  input: { workroomId: string; contactId: string },
  now: Date = new Date(),
): Promise<Outcome<IssuedInvitation>> {
  const workroom = await findWorkroom(input.workroomId);
  if (!workroom) return refuse("not_found", "That workroom no longer exists.");
  if (workroom.archivedAt) return refuse("blocked", "That workroom is archived.");
  if (workroom.status !== "published") {
    // An invitation into an unpublished workroom is a link that does not work.
    // Better to refuse it here than to send somebody a dead door.
    return refuse("blocked", "Publish this workroom before inviting anybody into it.");
  }

  const [person] = await db()
    .select({
      id: contacts.id,
      name: contacts.name,
      email: contacts.email,
      archivedAt: contacts.archivedAt,
      accessEmail: clientIdentity.email,
      identityStatus: clientIdentity.status,
    })
    .from(contacts)
    .leftJoin(clientIdentity, eq(clientIdentity.contactId, contacts.id))
    .where(eq(contacts.id, input.contactId))
    .limit(1);

  if (!person) return refuse("not_found", "That contact no longer exists.");
  if (person.archivedAt) return refuse("blocked", `${person.name} is archived.`);

  const email = person.accessEmail ?? person.email;
  if (!email) {
    return refuse(
      "blocked",
      `${person.name} has no email address, so there is nowhere to send an invitation. Add one to their contact first.`,
    );
  }
  if (person.identityStatus === "inactive") {
    return refuse("blocked", `${person.name}'s access has been switched off. Re-enable it first.`);
  }

  const already = await db()
    .select({ id: workroomMembers.id })
    .from(workroomMembers)
    .where(
      and(
        eq(workroomMembers.workroomId, input.workroomId),
        eq(workroomMembers.contactId, input.contactId),
        eq(workroomMembers.status, "active"),
      ),
    )
    .limit(1);
  if (already.length > 0) {
    return refuse("already_done", `${person.name} already has access to this workroom.`);
  }

  const token = randomBytes(32).toString("hex");
  const id = uuidv7(now.getTime());
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  try {
    await db().transaction(async (tx) => {
      await tx.insert(workroomInvitations).values({
        id,
        workroomId: input.workroomId,
        contactId: input.contactId,
        email,
        tokenHash: hashToken(token),
        expiresAt,
        createdBy: actor.id,
      });
      await recordAudit(tx, actor, {
        action: "workroom_invitation.created",
        entityType: "workroom_invitation",
        entityId: id,
        entityLabel: `${person.name} → ${workroom.title}`,
        metadata: { workroom_id: input.workroomId, contact_id: input.contactId },
      });
    });
  } catch (error) {
    // At most one open invitation per Workroom and Contact, decided by a
    // partial unique index rather than by a read both presses could pass.
    if (describes(error, "workroom_invitations_one_open_idx")) {
      return refuse("already_done", `${person.name} already has an invitation waiting.`);
    }
    throw error;
  }

  return ok({ id, token, email, expiresAt });
}

/**
 * Resending revokes the old invitation and issues a new one, in one
 * transaction, so there is never a moment with two usable links and never one
 * with none.
 */
export async function resendWorkroomInvitation(
  actor: AuditActor,
  invitationId: string,
  now: Date = new Date(),
): Promise<Outcome<IssuedInvitation>> {
  const [invite] = await db()
    .select({
      id: workroomInvitations.id,
      workroomId: workroomInvitations.workroomId,
      contactId: workroomInvitations.contactId,
      email: workroomInvitations.email,
      acceptedAt: workroomInvitations.acceptedAt,
      revokedAt: workroomInvitations.revokedAt,
      contactName: contacts.name,
      workroomTitle: workrooms.title,
    })
    .from(workroomInvitations)
    .innerJoin(contacts, eq(contacts.id, workroomInvitations.contactId))
    .innerJoin(workrooms, eq(workrooms.id, workroomInvitations.workroomId))
    .where(eq(workroomInvitations.id, invitationId))
    .limit(1);

  if (!invite) return refuse("not_found", "That invitation no longer exists.");
  if (invite.acceptedAt) return refuse("already_done", "That invitation has already been accepted.");
  if (invite.revokedAt) return refuse("blocked", "That invitation was revoked.");

  const token = randomBytes(32).toString("hex");
  const id = uuidv7(now.getTime());
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  await db().transaction(async (tx) => {
    await tx
      .update(workroomInvitations)
      .set({ revokedAt: now })
      .where(and(eq(workroomInvitations.id, invitationId), isNull(workroomInvitations.revokedAt)));

    await tx.insert(workroomInvitations).values({
      id,
      workroomId: invite.workroomId,
      contactId: invite.contactId,
      email: invite.email,
      tokenHash: hashToken(token),
      expiresAt,
      createdBy: actor.id,
    });

    await recordAudit(tx, actor, {
      action: "workroom_invitation.resent",
      entityType: "workroom_invitation",
      entityId: id,
      entityLabel: `${invite.contactName} → ${invite.workroomTitle}`,
      metadata: { workroom_id: invite.workroomId, replaced: invitationId },
    });
  });

  return ok({ id, token, email: invite.email, expiresAt });
}

export async function revokeWorkroomInvitation(
  actor: AuditActor,
  invitationId: string,
  now: Date = new Date(),
): Promise<Outcome<void>> {
  const [invite] = await db()
    .select({
      id: workroomInvitations.id,
      acceptedAt: workroomInvitations.acceptedAt,
      revokedAt: workroomInvitations.revokedAt,
      contactName: contacts.name,
      workroomTitle: workrooms.title,
    })
    .from(workroomInvitations)
    .innerJoin(contacts, eq(contacts.id, workroomInvitations.contactId))
    .innerJoin(workrooms, eq(workrooms.id, workroomInvitations.workroomId))
    .where(eq(workroomInvitations.id, invitationId))
    .limit(1);

  if (!invite) return ok(undefined);
  if (invite.acceptedAt) return refuse("blocked", "That invitation has already been accepted.");
  if (invite.revokedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    await tx
      .update(workroomInvitations)
      .set({ revokedAt: now })
      .where(eq(workroomInvitations.id, invitationId));

    await recordAudit(tx, actor, {
      action: "workroom_invitation.revoked",
      entityType: "workroom_invitation",
      entityId: invitationId,
      entityLabel: `${invite.contactName} → ${invite.workroomTitle}`,
    });
    return ok(undefined);
  });
}

/* ----------------------------------------------------------- acceptance */

export type InvitationFailure = "invalid" | "expired" | "revoked" | "already_used" | "unavailable";

export type InvitationPreview = {
  workroomTitle: string;
  clientName: string;
  contactName: string;
  email: string;
};

/**
 * What the confirmation page shows, and nothing more.
 *
 * Reading an invitation does **not** consume it: mail security scanners and
 * link previewers open URLs before a person does, and an invitation spent on a
 * scanner's request would lock the client out before they ever saw it.
 */
export async function inspectWorkroomInvitation(
  token: string,
  now: Date = new Date(),
): Promise<{ ok: true; preview: InvitationPreview } | { ok: false; reason: InvitationFailure }> {
  if (!token) return { ok: false, reason: "invalid" };

  const [invite] = await db()
    .select({
      email: workroomInvitations.email,
      expiresAt: workroomInvitations.expiresAt,
      acceptedAt: workroomInvitations.acceptedAt,
      revokedAt: workroomInvitations.revokedAt,
      contactName: contacts.name,
      workroomTitle: workrooms.title,
      workroomStatus: workrooms.status,
      workroomArchivedAt: workrooms.archivedAt,
      clientName: clients.name,
    })
    .from(workroomInvitations)
    .innerJoin(contacts, eq(contacts.id, workroomInvitations.contactId))
    .innerJoin(workrooms, eq(workrooms.id, workroomInvitations.workroomId))
    .innerJoin(projects, eq(projects.id, workrooms.projectId))
    .innerJoin(clients, eq(clients.id, projects.clientId))
    .where(eq(workroomInvitations.tokenHash, hashToken(token)))
    .limit(1);

  if (!invite) return { ok: false, reason: "invalid" };
  if (invite.acceptedAt) return { ok: false, reason: "already_used" };
  if (invite.revokedAt) return { ok: false, reason: "revoked" };
  if (invite.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (invite.workroomArchivedAt || invite.workroomStatus !== "published") {
    return { ok: false, reason: "unavailable" };
  }

  return {
    ok: true,
    preview: {
      workroomTitle: invite.workroomTitle,
      clientName: invite.clientName,
      contactName: invite.contactName,
      email: invite.email,
    },
  };
}

export type Accepted = { identityId: string; publicId: string };

/**
 * Accepting, as one transaction.
 *
 * Claim the invitation conditionally, create or reuse the client identity,
 * grant or restore the membership, and write both records of it. Of two
 * simultaneous submissions exactly one proceeds, because the claim requires the
 * invitation still to be unaccepted — the other finds nothing to claim and
 * everything it did goes back with its transaction.
 *
 * The session is issued afterwards, by the endpoint in
 * `lib/client-auth/invitation-plugin.ts`, and only if this committed.
 */
export async function acceptWorkroomInvitation(
  input: { token: string; name: string },
  now: Date = new Date(),
): Promise<{ ok: true } & Accepted | { ok: false; reason: InvitationFailure }> {
  const checked = await inspectWorkroomInvitation(input.token, now);
  if (!checked.ok) return checked;

  const tokenHash = hashToken(input.token);

  try {
    return await db().transaction(async (tx) => {
      const claimed = await tx
        .update(workroomInvitations)
        .set({ acceptedAt: now })
        .where(
          and(
            eq(workroomInvitations.tokenHash, tokenHash),
            isNull(workroomInvitations.acceptedAt),
            isNull(workroomInvitations.revokedAt),
            gt(workroomInvitations.expiresAt, now),
          ),
        )
        .returning({
          id: workroomInvitations.id,
          workroomId: workroomInvitations.workroomId,
          contactId: workroomInvitations.contactId,
          email: workroomInvitations.email,
        });

      if (claimed.length === 0) throw new NotAccepted("already_used");
      const invite = claimed[0]!;

      const [workroom] = await tx
        .select({ id: workrooms.id, publicId: workrooms.publicId, title: workrooms.title })
        .from(workrooms)
        .where(eq(workrooms.id, invite.workroomId))
        .limit(1);
      if (!workroom) throw new NotAccepted("unavailable");

      const [person] = await tx
        .select({ name: contacts.name })
        .from(contacts)
        .where(eq(contacts.id, invite.contactId))
        .limit(1);
      const displayName = input.name.trim() || person?.name || invite.email.split("@")[0]!;

      // Reuse the identity if the person already has one. Nobody should need a
      // separate account per project.
      const [existing] = await tx
        .select({ id: clientIdentity.id, status: clientIdentity.status })
        .from(clientIdentity)
        .where(eq(clientIdentity.contactId, invite.contactId))
        .limit(1);

      if (existing?.status === "inactive") throw new NotAccepted("unavailable");

      /**
       * Creating the identity has to survive two collisions, because the read
       * above cannot see either of them.
       *
       * The same person accepting invitations to two workrooms in the same
       * moment: neither transaction sees the other's uncommitted row, both
       * insert, and one used to die on `client_identities_contact_id_idx` —
       * a 500 on a legitimate click. Measured, in a test that races two
       * acceptances.
       *
       * And two different Contacts carrying one address: `contacts` does not
       * make email unique (a shared inbox is a real thing, and so are
       * duplicate rows), but a client identity's email is a credential and
       * `client_identities_email_idx` does. That one is not a race at all — it
       * is simply impossible — and it must be a refusal somebody can act on
       * rather than a crash.
       *
       * So the insert yields rather than fights, and then the row is read back:
       * present under this Contact means somebody else got there first and we
       * reuse it; absent means the address belongs to another Contact.
       */
      const inserted = existing
        ? []
        : await tx
            .insert(clientIdentity)
            .values({
              id: uuidv7(now.getTime()),
              name: displayName,
              // The verified access email is the address this link was sent to,
              // and nothing afterwards copies `contacts.email` into it.
              email: invite.email,
              emailVerified: true,
              contactId: invite.contactId,
              status: "active",
            })
            .onConflictDoNothing()
            .returning({ id: clientIdentity.id });

      let identityId = existing?.id ?? inserted[0]?.id;

      if (!identityId) {
        const [raced] = await tx
          .select({ id: clientIdentity.id, status: clientIdentity.status })
          .from(clientIdentity)
          .where(eq(clientIdentity.contactId, invite.contactId))
          .limit(1);

        if (!raced) {
          log.warn("client.identity_email_taken", {
            contact_id: invite.contactId,
            email: redactEmail(invite.email),
          });
          throw new NotAccepted("unavailable");
        }
        if (raced.status === "inactive") throw new NotAccepted("unavailable");
        identityId = raced.id;
      }

      const actor: AuditActor = { id: identityId, name: displayName, kind: "client_user" };

      if (inserted.length > 0) {
        await recordAudit(tx, actor, {
          action: "client_identity.created",
          entityType: "client_identity",
          entityId: identityId,
          entityLabel: displayName,
          metadata: { contact_id: invite.contactId },
        });
      }

      const [member] = await tx
        .select({ id: workroomMembers.id, status: workroomMembers.status })
        .from(workroomMembers)
        .where(
          and(
            eq(workroomMembers.workroomId, invite.workroomId),
            eq(workroomMembers.contactId, invite.contactId),
          ),
        )
        .limit(1);

      if (member) {
        await tx
          .update(workroomMembers)
          .set({ status: "active", grantedAt: now, revokedAt: null, revokedBy: null })
          .where(eq(workroomMembers.id, member.id));
      } else {
        await tx.insert(workroomMembers).values({
          id: uuidv7(now.getTime()),
          workroomId: invite.workroomId,
          contactId: invite.contactId,
          status: "active",
        });
      }

      await recordAudit(tx, actor, {
        action: "workroom_invitation.accepted",
        entityType: "workroom_invitation",
        entityId: invite.id,
        entityLabel: `${displayName} → ${workroom.title}`,
        metadata: { workroom_id: workroom.id, contact_id: invite.contactId },
      });
      await recordActivity(tx, workroom.id, {
        kind: "workroom.joined",
        actorLabel: displayName,
      });

      return { ok: true as const, identityId, publicId: workroom.publicId };
    });
  } catch (error) {
    if (error instanceof NotAccepted) return { ok: false, reason: error.reason };
    throw error;
  }
}

/** Carries a refusal out of the acceptance transaction, rolling it back. */
class NotAccepted extends Error {
  reason: InvitationFailure;

  constructor(reason: InvitationFailure) {
    super(reason);
    this.reason = reason;
  }
}

/* ------------------------------------------------------------- membership */

/**
 * Removing one person from one Workroom.
 *
 * Immediate, because access is read from this row on every request rather than
 * trusted from a session. Their other Workrooms are untouched and they are not
 * signed out — a client who works with the studio on two projects should not
 * lose the second because the first ended.
 */
export async function revokeMembership(
  actor: AuditActor,
  memberId: string,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<Outcome<void>> {
  const [member] = await db()
    .select({
      id: workroomMembers.id,
      status: workroomMembers.status,
      workroomId: workroomMembers.workroomId,
      workroomTitle: workrooms.title,
      contactName: contacts.name,
    })
    .from(workroomMembers)
    .innerJoin(workrooms, eq(workrooms.id, workroomMembers.workroomId))
    .innerJoin(contacts, eq(contacts.id, workroomMembers.contactId))
    .where(eq(workroomMembers.id, memberId))
    .limit(1);

  if (!member) return refuse("not_found", "That person is no longer listed here.");
  if (member.status === "revoked") return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomMembers)
      .set({ status: "revoked", revokedAt: now, revokedBy: actor.id })
      .where(and(eq(workroomMembers.id, memberId), eq(workroomMembers.version, expectedVersion)))
      .returning({ id: workroomMembers.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom_member.revoked",
      entityType: "workroom_member",
      entityId: memberId,
      entityLabel: `${member.contactName} → ${member.workroomTitle}`,
      metadata: { workroom_id: member.workroomId },
    });
    await recordActivity(tx, member.workroomId, {
      kind: "workroom.access_ended",
      subject: member.contactName,
    });

    return ok(undefined);
  });
}

/** Giving access back to somebody who had it, without a second invitation. */
export async function restoreMembership(
  actor: AuditActor,
  memberId: string,
  expectedVersion: number,
  now: Date = new Date(),
): Promise<Outcome<void>> {
  const [member] = await db()
    .select({
      id: workroomMembers.id,
      status: workroomMembers.status,
      workroomId: workroomMembers.workroomId,
      workroomTitle: workrooms.title,
      contactId: workroomMembers.contactId,
      contactName: contacts.name,
      contactArchivedAt: contacts.archivedAt,
      identityStatus: clientIdentity.status,
    })
    .from(workroomMembers)
    .innerJoin(workrooms, eq(workrooms.id, workroomMembers.workroomId))
    .innerJoin(contacts, eq(contacts.id, workroomMembers.contactId))
    .leftJoin(clientIdentity, eq(clientIdentity.contactId, workroomMembers.contactId))
    .where(eq(workroomMembers.id, memberId))
    .limit(1);

  if (!member) return refuse("not_found", "That person is no longer listed here.");
  if (member.status === "active") return ok(undefined);
  if (member.contactArchivedAt) {
    return refuse("blocked", `${member.contactName} is archived. Restore the contact first.`);
  }
  if (member.identityStatus === "inactive") {
    return refuse("blocked", `${member.contactName}'s access has been switched off entirely.`);
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(workroomMembers)
      .set({ status: "active", grantedAt: now, grantedBy: actor.id, revokedAt: null, revokedBy: null })
      .where(and(eq(workroomMembers.id, memberId), eq(workroomMembers.version, expectedVersion)))
      .returning({ id: workroomMembers.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await recordAudit(tx, actor, {
      action: "workroom_member.granted",
      entityType: "workroom_member",
      entityId: memberId,
      entityLabel: `${member.contactName} → ${member.workroomTitle}`,
      metadata: { workroom_id: member.workroomId },
    });
    await recordActivity(tx, member.workroomId, {
      kind: "workroom.access_granted",
      subject: member.contactName,
    });

    return ok(undefined);
  });
}

/**
 * Switching a person's access off everywhere at once, or back on.
 *
 * Different from revoking a membership, and Owner-only for that reason: this
 * stops every existing session on its next request, in every Workroom. Nothing
 * is deleted — access history is why the audit log exists.
 */
export async function setIdentityStatus(
  actor: AuditActor,
  identityId: string,
  status: "active" | "inactive",
): Promise<Outcome<void>> {
  const [identity] = await db()
    .select({ id: clientIdentity.id, name: clientIdentity.name, status: clientIdentity.status })
    .from(clientIdentity)
    .where(eq(clientIdentity.id, identityId))
    .limit(1);

  if (!identity) return refuse("not_found", "That person has no sign-in to change.");
  if (identity.status === status) return ok(undefined);

  return db().transaction(async (tx) => {
    await tx.update(clientIdentity).set({ status }).where(eq(clientIdentity.id, identityId));

    await recordAudit(tx, actor, {
      action: status === "active" ? "client_identity.enabled" : "client_identity.disabled",
      entityType: "client_identity",
      entityId: identityId,
      entityLabel: identity.name,
    });
    return ok(undefined);
  });
}

/* ----------------------------------------------------------- client reads */

/**
 * Whether an address may be sent a sign-in link at all.
 *
 * The answer is never told to the caller — `sendMagicLink` returns quietly
 * either way — so this exists to decide whether mail is sent, not to produce a
 * message. An address qualifies only with an active identity **and** at least
 * one active membership in a published, unarchived Workroom: an unpublished
 * Workroom or a revoked membership is the same as never having had one.
 */
export async function canSignIn(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const [row] = await db()
    .select({ n: count() })
    .from(clientIdentity)
    .innerJoin(workroomMembers, eq(workroomMembers.contactId, clientIdentity.contactId))
    .innerJoin(workrooms, eq(workrooms.id, workroomMembers.workroomId))
    .where(
      and(
        sql`lower(${clientIdentity.email}) = ${normalized}`,
        eq(clientIdentity.status, "active"),
        eq(workroomMembers.status, "active"),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
      ),
    );

  return (row?.n ?? 0) > 0;
}

export type ViewerIdentity = {
  id: string;
  name: string;
  email: string;
  contactId: string;
};

/** The signed-in client, re-checked against the database on every request. */
export async function findActiveIdentity(id: string): Promise<ViewerIdentity | null> {
  const [row] = await db()
    .select({
      id: clientIdentity.id,
      name: contacts.name,
      email: clientIdentity.email,
      contactId: clientIdentity.contactId,
    })
    .from(clientIdentity)
    .innerJoin(contacts, eq(contacts.id, clientIdentity.contactId))
    .where(
      and(
        eq(clientIdentity.id, id),
        eq(clientIdentity.status, "active"),
        isNull(contacts.archivedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}

/** Everything the viewer may open. Never anything else — there is no filter to forget. */
export async function workroomsForViewer(contactId: string): Promise<WorkroomRow[]> {
  const rows = await joined()
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(
      and(
        eq(workroomMembers.contactId, contactId),
        eq(workroomMembers.status, "active"),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
      ),
    )
    .orderBy(desc(workrooms.updatedAt))
    .limit(100);

  return rows as WorkroomRow[];
}

/**
 * One Workroom, for one viewer, or null.
 *
 * Membership is part of the query rather than a check after it, so a
 * non-member's request never reads the row at all. Null for a Workroom that
 * exists and one that never did, so nothing distinguishes them.
 */
export async function workroomForViewer(
  contactId: string,
  publicId: string,
): Promise<WorkroomRow | null> {
  const [row] = await joined()
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(
      and(
        eq(workrooms.publicId, publicId),
        eq(workroomMembers.contactId, contactId),
        eq(workroomMembers.status, "active"),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
      ),
    )
    .limit(1);

  return (row as WorkroomRow | undefined) ?? null;
}

export type WorkroomPerson = { name: string; role: string | null };

/** Who else is in this Workroom. Members only — never everybody at the Client. */
export async function workroomPeople(workroomId: string): Promise<WorkroomPerson[]> {
  const rows = await db()
    .select({ name: contacts.name, role: clientContacts.role })
    .from(workroomMembers)
    .innerJoin(contacts, eq(contacts.id, workroomMembers.contactId))
    .leftJoin(
      clientContacts,
      and(
        eq(clientContacts.contactId, contacts.id),
        eq(
          clientContacts.clientId,
          sql`(SELECT p.client_id FROM workrooms w JOIN projects p ON p.id = w.project_id WHERE w.id = ${workroomId})`,
        ),
      ),
    )
    .where(and(eq(workroomMembers.workroomId, workroomId), eq(workroomMembers.status, "active")))
    .orderBy(asc(contacts.name))
    .limit(50);

  return rows as WorkroomPerson[];
}

/* --------------------------------------------------- Build 003 lifecycle */

/** Workrooms a Contact still holds live access to. Blocks archiving them. */
export async function activeAccessFor(contactId: string): Promise<string[]> {
  const rows = await db()
    .select({ title: workrooms.title })
    .from(workroomMembers)
    .innerJoin(workrooms, eq(workrooms.id, workroomMembers.workroomId))
    .where(
      and(
        eq(workroomMembers.contactId, contactId),
        eq(workroomMembers.status, "active"),
        isNull(workrooms.archivedAt),
      ),
    )
    .limit(5);

  return rows.map((row) => row.title);
}

/** A published Workroom on a Project blocks archiving that Project. */
export async function publishedWorkroomFor(projectId: string): Promise<string | null> {
  const [row] = await db()
    .select({ title: workrooms.title })
    .from(workrooms)
    .where(
      and(
        eq(workrooms.projectId, projectId),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
      ),
    )
    .limit(1);

  return row?.title ?? null;
}

/**
 * A Project's status changed, and its client should be told — in their words.
 *
 * The internal half of the same business event is already in the audit log,
 * with the actor and the field names. This carries the status and nothing else:
 * not who inside the studio changed it, not why, not the note beside it.
 */
export async function recordProjectStatusForClients(
  tx: Tx,
  projectId: string,
  statusLabel: string,
): Promise<void> {
  const [workroom] = await tx
    .select({ id: workrooms.id })
    .from(workrooms)
    .where(
      and(
        eq(workrooms.projectId, projectId),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
      ),
    )
    .limit(1);

  if (!workroom) return;
  await recordActivity(tx, workroom.id, {
    kind: "project.status_changed",
    subject: statusLabel,
  });
}
