import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { record, type AuditActor, changedFields } from "./audit.ts";
import { db, type Tx } from "./index.ts";
import { activeAccessFor } from "./workrooms.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import {
  clientContacts,
  clients,
  contacts,
  projectContacts,
  projects,
  PROJECT_LIVE_STATUSES,
} from "./schema.ts";

/**
 * Contacts: the person, never the business. A contact belongs to nobody — they
 * are related to clients and to projects, and the same person can be related to
 * several of each without being duplicated. The model is in
 * docs/business-core.md.
 *
 * Email is deliberately not unique. Shared addresses (office@, a couple sharing
 * an inbox) and imports are real, and a constraint would turn each of them into
 * a dead end. Duplicates are found and warned about instead, by
 * `similarContacts`, which is a suggestion rather than a refusal.
 */

export type Contact = {
  id: string;
  name: string;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  title: string | null;
  notes: string;
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContactRow = Contact & {
  clientCount: number;
  projectCount: number;
};

export type ContactInput = {
  name: string;
  email: string | null;
  emailNormalized: string | null;
  phone: string | null;
  title: string | null;
  notes: string;
};

export type ContactFilter = {
  query?: string;
  clientId?: string | null;
  archived?: "active" | "archived";
  page?: number;
  pageSize?: number;
};

/** One row of "who this person is to us", for a contact's own page. */
export type ContactRelationship = {
  id: string;
  role: string | null;
  isPrimary: boolean;
  version: number;
  clientId: string;
  clientName: string;
  clientArchived: boolean;
};

/** One row of "who these people are to this client", for a client's page. */
export type ClientContactRow = {
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
  id: contacts.id,
  name: contacts.name,
  email: contacts.email,
  emailNormalized: contacts.emailNormalized,
  phone: contacts.phone,
  title: contacts.title,
  notes: contacts.notes,
  version: contacts.version,
  archivedAt: contacts.archivedAt,
  createdAt: contacts.createdAt,
  updatedAt: contacts.updatedAt,
};

/** Compile-time constants only — never a caller's value. */
function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function filterClause(filter: ContactFilter): SQL | undefined {
  const where: SQL[] = [];

  where.push(
    filter.archived === "archived" ? isNotNull(contacts.archivedAt) : isNull(contacts.archivedAt),
  );

  if (filter.query) {
    const like = `%${filter.query}%`;
    where.push(
      or(ilike(contacts.name, like), ilike(contacts.email, like), ilike(contacts.phone, like)) as SQL,
    );
  }

  if (filter.clientId) {
    where.push(sql`EXISTS (
      SELECT 1 FROM client_contacts cc
      WHERE cc.contact_id = contacts.id AND cc.client_id = ${filter.clientId}
    )`);
  }

  return where.length > 0 ? and(...where) : undefined;
}

/**
 * The index. Filtered, sorted and paged by the database, with the two counts
 * that make a row worth reading fetched alongside rather than per row.
 *
 * Written with plain identifiers inside the subqueries: Drizzle drops the table
 * prefix when it matches the outer FROM, and `contact_id = id` is ambiguous to
 * Postgres. The only caller value here is parameterized.
 */
export async function listContacts(
  filter: ContactFilter = {},
): Promise<{ rows: ContactRow[]; total: number }> {
  const pageSize = filter.pageSize ?? 25;
  const page = filter.page ?? 1;
  const clause = filterClause(filter);

  const clientCount = sql<number>`(
    SELECT count(*)::int FROM client_contacts cc
    JOIN clients cl ON cl.id = cc.client_id
    WHERE cc.contact_id = contacts.id AND cl.archived_at IS NULL
  )`;

  const projectCount = sql<number>`(
    SELECT count(*)::int FROM project_contacts pc
    JOIN projects p ON p.id = pc.project_id
    WHERE pc.contact_id = contacts.id
      AND p.archived_at IS NULL
      AND p.status IN (${sql.raw(quotedList(PROJECT_LIVE_STATUSES))})
  )`;

  const [rows, [total]] = await Promise.all([
    db()
      .select({ ...columns, clientCount, projectCount })
      .from(contacts)
      .where(clause)
      .orderBy(desc(contacts.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: count() }).from(contacts).where(clause),
  ]);

  return { rows: rows as ContactRow[], total: total?.n ?? 0 };
}

export async function findContact(id: string): Promise<Contact | null> {
  const [row] = await db().select(columns).from(contacts).where(eq(contacts.id, id)).limit(1);
  return (row as Contact | undefined) ?? null;
}

/** For selects: every person somebody could reasonably attach to something. */
export async function selectableContacts(): Promise<{ id: string; name: string; email: string | null }[]> {
  return db()
    .select({ id: contacts.id, name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(isNull(contacts.archivedAt))
    .orderBy(asc(contacts.name))
    .limit(500);
}

/**
 * People who look like the one about to be created. A warning, never a refusal:
 * two people genuinely do share a name, and a shared inbox is not a mistake.
 */
export async function similarContacts(
  input: { name: string; emailNormalized: string | null },
  excludeId?: string,
): Promise<{ id: string; name: string; email: string | null }[]> {
  const matches: SQL[] = [ilike(contacts.name, input.name)];
  if (input.emailNormalized) matches.push(eq(contacts.emailNormalized, input.emailNormalized));

  const where: SQL[] = [isNull(contacts.archivedAt), or(...matches) as SQL];
  if (excludeId) where.push(ne(contacts.id, excludeId));

  return db()
    .select({ id: contacts.id, name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(and(...where))
    .limit(5);
}

export async function createContact(
  actor: AuditActor,
  input: ContactInput,
): Promise<Outcome<string>> {
  const id = uuidv7();

  await db().transaction(async (tx) => {
    await insertContact(tx, actor, id, input);
  });

  return ok(id);
}

/**
 * The insert on its own, so the flows that create a person as part of something
 * larger — an inquiry becoming a lead — write the same row and the same audit
 * event inside their own transaction rather than reimplementing both.
 */
export async function insertContact(
  tx: Tx,
  actor: AuditActor,
  id: string,
  input: ContactInput,
): Promise<void> {
  await tx.insert(contacts).values({ ...input, id, createdBy: actor.id, updatedBy: actor.id });
  await record(tx, actor, {
    action: "contact.created",
    entityType: "contact",
    entityId: id,
    entityLabel: input.name,
  });
}

export async function updateContact(
  actor: AuditActor,
  id: string,
  input: ContactInput,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const before = await findContact(id);
  if (!before) return refuse("not_found", "That contact no longer exists.");

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(contacts)
      .set({ ...input, updatedBy: actor.id })
      .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
      .returning({ id: contacts.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "contact.updated",
      entityType: "contact",
      entityId: id,
      entityLabel: input.name,
      // The names of what changed, never the values. See docs/audit.md.
      metadata: { fields: changedFields(before as unknown as Record<string, unknown>, input) },
    });

    return ok(undefined);
  });
}

/**
 * Archiving is refused while this person is still the named primary somewhere,
 * because a client whose one named contact has disappeared from every list is a
 * worse state than a refusal. Nominate somebody else first, or clear the flag.
 */
export async function archiveContact(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const contact = await findContact(id);
  if (!contact) return refuse("not_found", "That contact no longer exists.");
  if (contact.archivedAt) return ok(undefined);

  const primaryFor = await primaryAttachments(id);
  if (primaryFor.length > 0) {
    return refuse(
      "blocked",
      `${contact.name} is still the primary contact for ${primaryFor.join(", ")}. Name somebody else there first.`,
    );
  }

  // Archiving somebody who can still open a workroom would leave a live door
  // belonging to a person the studio thinks has gone. See docs/workrooms.md.
  const access = await activeAccessFor(id);
  if (access.length > 0) {
    return refuse(
      "blocked",
      `${contact.name} still has access to ${access.join(", ")}. Take that away first.`,
    );
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(contacts)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
      .returning({ id: contacts.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "contact.archived",
      entityType: "contact",
      entityId: id,
      entityLabel: contact.name,
    });
    return ok(undefined);
  });
}

/** The live clients and projects this person is the named primary for. */
async function primaryAttachments(contactId: string): Promise<string[]> {
  const [asClient, asProject] = await Promise.all([
    db()
      .select({ name: clients.name })
      .from(clientContacts)
      .innerJoin(clients, eq(clients.id, clientContacts.clientId))
      .where(
        and(
          eq(clientContacts.contactId, contactId),
          eq(clientContacts.isPrimary, true),
          isNull(clients.archivedAt),
        ),
      )
      .limit(5),
    db()
      .select({ name: projects.name })
      .from(projectContacts)
      .innerJoin(projects, eq(projects.id, projectContacts.projectId))
      .where(
        and(
          eq(projectContacts.contactId, contactId),
          eq(projectContacts.isPrimary, true),
          isNull(projects.archivedAt),
        ),
      )
      .limit(5),
  ]);

  return [...asClient, ...asProject].map((row) => row.name);
}

export async function restoreContact(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const contact = await findContact(id);
  if (!contact) return refuse("not_found", "That contact no longer exists.");
  if (!contact.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(contacts)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(contacts.id, id), eq(contacts.version, expectedVersion)))
      .returning({ id: contacts.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "contact.restored",
      entityType: "contact",
      entityId: id,
      entityLabel: contact.name,
    });
    return ok(undefined);
  });
}

/* ------------------------------------------------------- client ↔ contact */

/** Everyone attached to one client, primary first, then by name. */
export async function clientContactRows(clientId: string): Promise<ClientContactRow[]> {
  return db()
    .select({
      id: clientContacts.id,
      role: clientContacts.role,
      isPrimary: clientContacts.isPrimary,
      version: clientContacts.version,
      contactId: contacts.id,
      contactName: contacts.name,
      contactEmail: contacts.email,
      contactTitle: contacts.title,
      contactArchived: sql<boolean>`(${contacts.archivedAt} IS NOT NULL)`,
    })
    .from(clientContacts)
    .innerJoin(contacts, eq(contacts.id, clientContacts.contactId))
    .where(eq(clientContacts.clientId, clientId))
    .orderBy(desc(clientContacts.isPrimary), asc(contacts.name))
    .limit(200);
}

/** Every client one person is related to, for their own page. */
export async function contactRelationships(contactId: string): Promise<ContactRelationship[]> {
  return db()
    .select({
      id: clientContacts.id,
      role: clientContacts.role,
      isPrimary: clientContacts.isPrimary,
      version: clientContacts.version,
      clientId: clients.id,
      clientName: clients.name,
      clientArchived: sql<boolean>`(${clients.archivedAt} IS NOT NULL)`,
    })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .where(eq(clientContacts.contactId, contactId))
    .orderBy(desc(clientContacts.isPrimary), asc(clients.name))
    .limit(200);
}

/**
 * Relates a person to a client. Idempotent by the database rather than by a
 * read both of two concurrent presses could pass: the pair is unique, so the
 * second insert loses and is reported as already done.
 */
export async function attachContactToClient(
  actor: AuditActor,
  input: { clientId: string; contactId: string; role: string | null; isPrimary: boolean },
): Promise<Outcome<string>> {
  const [client] = await db()
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, input.clientId))
    .limit(1);
  if (!client) return refuse("not_found", "That client no longer exists.");

  const contact = await findContact(input.contactId);
  if (!contact) return refuse("not_found", "That contact no longer exists.");

  return db().transaction(async (tx) => {
    // Clearing first, because at most one primary per client is a unique index
    // and the insert would be refused rather than take over.
    if (input.isPrimary) await clearPrimaryForClient(tx, input.clientId);

    const id = uuidv7();
    const inserted = await tx
      .insert(clientContacts)
      .values({ ...input, id, createdBy: actor.id })
      .onConflictDoNothing({ target: [clientContacts.clientId, clientContacts.contactId] })
      .returning({ id: clientContacts.id });

    if (inserted.length === 0) {
      return refuse<string>("already_done", `${contact.name} is already listed for ${client.name}.`);
    }

    await record(tx, actor, {
      action: "client_contact.attached",
      entityType: "client_contact",
      entityId: id,
      entityLabel: `${contact.name} → ${client.name}`,
      metadata: { client_id: input.clientId, contact_id: input.contactId, primary: input.isPrimary },
    });

    return ok(id);
  });
}

async function clearPrimaryForClient(tx: Tx, clientId: string): Promise<void> {
  await tx
    .update(clientContacts)
    .set({ isPrimary: false })
    .where(and(eq(clientContacts.clientId, clientId), eq(clientContacts.isPrimary, true)));
}

/** Changes what somebody is to a client: their role, or who is named primary. */
export async function updateClientContact(
  actor: AuditActor,
  id: string,
  input: { role: string | null; isPrimary: boolean },
  expectedVersion: number,
): Promise<Outcome<void>> {
  const [row] = await db()
    .select({
      clientId: clientContacts.clientId,
      clientName: clients.name,
      contactName: contacts.name,
    })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .innerJoin(contacts, eq(contacts.id, clientContacts.contactId))
    .where(eq(clientContacts.id, id))
    .limit(1);

  if (!row) return refuse("not_found", "That relationship no longer exists.");

  return db().transaction(async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(clientContacts)
        .set({ isPrimary: false })
        .where(
          and(
            eq(clientContacts.clientId, row.clientId),
            eq(clientContacts.isPrimary, true),
            ne(clientContacts.id, id),
          ),
        );
    }

    const changed = await tx
      .update(clientContacts)
      .set(input)
      .where(and(eq(clientContacts.id, id), eq(clientContacts.version, expectedVersion)))
      .returning({ id: clientContacts.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "client_contact.updated",
      entityType: "client_contact",
      entityId: id,
      entityLabel: `${row.contactName} → ${row.clientName}`,
      metadata: { primary: input.isPrimary },
    });

    return ok(undefined);
  });
}

/**
 * Removes the relationship, not the person. This is the one place in the
 * business core where a row is deleted rather than archived, because the row
 * *is* the relationship: once it is wrong, keeping it says something untrue.
 * The contact and the client both survive, and the audit event remains.
 */
export async function detachContactFromClient(
  actor: AuditActor,
  id: string,
): Promise<Outcome<void>> {
  const [row] = await db()
    .select({ clientName: clients.name, contactName: contacts.name })
    .from(clientContacts)
    .innerJoin(clients, eq(clients.id, clientContacts.clientId))
    .innerJoin(contacts, eq(contacts.id, clientContacts.contactId))
    .where(eq(clientContacts.id, id))
    .limit(1);

  if (!row) return ok(undefined);

  return db().transaction(async (tx) => {
    await tx.delete(clientContacts).where(eq(clientContacts.id, id));
    await record(tx, actor, {
      action: "client_contact.detached",
      entityType: "client_contact",
      entityId: id,
      entityLabel: `${row.contactName} → ${row.clientName}`,
    });
    return ok(undefined);
  });
}
