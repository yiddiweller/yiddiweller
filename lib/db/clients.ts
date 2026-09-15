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
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import { record, type AuditActor, changedFields } from "./audit.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, expectUnchanged, type Outcome } from "./outcome.ts";
import {
  clients,
  projects,
  PROJECT_LIVE_STATUSES,
  type ClientAccountType,
  type ClientStatus,
} from "./schema.ts";

/**
 * Clients: the business relationship, never the person. The model is in
 * docs/business-core.md.
 *
 * Everything that changes a client goes through this module, in a transaction,
 * with its audit event written alongside.
 */

export type Client = {
  id: string;
  accountType: ClientAccountType;
  name: string;
  website: string | null;
  domain: string | null;
  status: ClientStatus;
  notes: string;
  /** What an edit must pass back. See lib/db/outcome.ts. */
  version: number;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClientRow = Client & {
  primaryContactName: string | null;
  liveProjects: number;
};

export type ClientInput = {
  accountType: ClientAccountType;
  name: string;
  website: string | null;
  domain: string | null;
  status: ClientStatus;
  notes: string;
};

export type ClientFilter = {
  query?: string;
  status?: ClientStatus | null;
  archived?: "active" | "archived";
  page?: number;
  pageSize?: number;
};

const columns = {
  id: clients.id,
  accountType: clients.accountType,
  name: clients.name,
  website: clients.website,
  domain: clients.domain,
  status: clients.status,
  notes: clients.notes,
  version: clients.version,
  archivedAt: clients.archivedAt,
  createdAt: clients.createdAt,
  updatedAt: clients.updatedAt,
};

/** Compile-time constants only — never a caller's value. */
function quotedList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function filterClause(filter: ClientFilter): SQL | undefined {
  const where: SQL[] = [];

  where.push(filter.archived === "archived" ? isNotNull(clients.archivedAt) : isNull(clients.archivedAt));
  if (filter.status) where.push(eq(clients.status, filter.status));
  if (filter.query) {
    const like = `%${filter.query}%`;
    where.push(or(ilike(clients.name, like), ilike(clients.domain, like)) as SQL);
  }

  return where.length > 0 ? and(...where) : undefined;
}

/**
 * The index. Server-side filtered, sorted and paged — the list must not assume
 * the studio will only ever have twenty clients.
 *
 * The primary contact and the live project count come from correlated
 * subqueries rather than a second round of queries per row, so the page stays
 * one database call regardless of how many clients it shows.
 */
export async function listClients(
  filter: ClientFilter = {},
): Promise<{ rows: ClientRow[]; total: number }> {
  const pageSize = filter.pageSize ?? 25;
  const page = filter.page ?? 1;
  const clause = filterClause(filter);

  // Written with plain identifiers rather than column references: inside a
  // correlated subquery Drizzle drops the table prefix when it matches the
  // outer FROM, and `client_id = id` is ambiguous to Postgres. No value here
  // comes from a caller, so there is nothing to parameterize.
  const primaryContactName = sql<string | null>`(
    SELECT c.name FROM client_contacts cc
    JOIN contacts c ON c.id = cc.contact_id
    WHERE cc.client_id = clients.id AND cc.is_primary
    LIMIT 1
  )`;

  const liveProjects = sql<number>`(
    SELECT count(*)::int FROM projects p
    WHERE p.client_id = clients.id
      AND p.archived_at IS NULL
      AND p.status IN (${sql.raw(quotedList(PROJECT_LIVE_STATUSES))})
  )`;

  const [rows, [total]] = await Promise.all([
    db()
      .select({ ...columns, primaryContactName, liveProjects })
      .from(clients)
      .where(clause)
      .orderBy(desc(clients.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: count() }).from(clients).where(clause),
  ]);

  return { rows: rows as ClientRow[], total: total?.n ?? 0 };
}

export async function findClient(id: string): Promise<Client | null> {
  const [row] = await db().select(columns).from(clients).where(eq(clients.id, id)).limit(1);
  return (row as Client | undefined) ?? null;
}

/** For selects: every client somebody could reasonably attach something to. */
export async function selectableClients(): Promise<{ id: string; name: string }[]> {
  return db()
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(isNull(clients.archivedAt))
    .orderBy(asc(clients.name))
    .limit(500);
}

/**
 * Clients that look like the one about to be created. A warning, never a
 * refusal: two businesses genuinely can share a name.
 */
export async function similarClients(input: {
  name: string;
  domain: string | null;
}): Promise<{ id: string; name: string }[]> {
  const matches: SQL[] = [ilike(clients.name, input.name)];
  if (input.domain) matches.push(eq(clients.domain, input.domain));

  return db()
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(isNull(clients.archivedAt), or(...matches)))
    .limit(5);
}

export async function createClient(actor: AuditActor, input: ClientInput): Promise<Outcome<string>> {
  const id = uuidv7();

  await db().transaction(async (tx) => {
    await insertClient(tx, actor, id, input);
  });

  return ok(id);
}

/**
 * The insert on its own, so converting a lead creates its client inside the
 * conversion's own transaction — same row, same audit event — rather than
 * reimplementing both and drifting from this one.
 */
export async function insertClient(
  tx: Tx,
  actor: AuditActor,
  id: string,
  input: ClientInput,
): Promise<void> {
  await tx.insert(clients).values({ ...input, id, createdBy: actor.id, updatedBy: actor.id });
  await record(tx, actor, {
    action: "client.created",
    entityType: "client",
    entityId: id,
    entityLabel: input.name,
    metadata: { account_type: input.accountType },
  });
}

export async function updateClient(
  actor: AuditActor,
  id: string,
  input: ClientInput,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const before = await findClient(id);
  if (!before) return refuse("not_found", "That client no longer exists.");

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(clients)
      .set({ ...input, updatedBy: actor.id })
      .where(and(eq(clients.id, id), eq(clients.version, expectedVersion)))
      .returning({ id: clients.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "client.updated",
      entityType: "client",
      entityId: id,
      entityLabel: input.name,
      // The names of what changed, never the values. See docs/audit.md.
      metadata: { fields: changedFields(before as unknown as Record<string, unknown>, input) },
    });

    return ok(undefined);
  });
}

/**
 * Archiving is refused while the client still has live work, because a project
 * whose client has vanished from every list is a worse state than a refusal.
 */
export async function archiveClient(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const client = await findClient(id);
  if (!client) return refuse("not_found", "That client no longer exists.");
  if (client.archivedAt) return ok(undefined);

  const live = await db()
    .select({ name: projects.name })
    .from(projects)
    .where(
      and(
        eq(projects.clientId, id),
        isNull(projects.archivedAt),
        inArray(projects.status, PROJECT_LIVE_STATUSES),
      ),
    )
    .limit(5);

  if (live.length > 0) {
    return refuse(
      "blocked",
      `${client.name} still has live work: ${live.map((p) => p.name).join(", ")}. Finish or archive those projects first.`,
    );
  }

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(clients)
      .set({ archivedAt: new Date(), updatedBy: actor.id })
      .where(and(eq(clients.id, id), eq(clients.version, expectedVersion)))
      .returning({ id: clients.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "client.archived",
      entityType: "client",
      entityId: id,
      entityLabel: client.name,
    });
    return ok(undefined);
  });
}

export async function restoreClient(
  actor: AuditActor,
  id: string,
  expectedVersion: number,
): Promise<Outcome<void>> {
  const client = await findClient(id);
  if (!client) return refuse("not_found", "That client no longer exists.");
  if (!client.archivedAt) return ok(undefined);

  return db().transaction(async (tx) => {
    const changed = await tx
      .update(clients)
      .set({ archivedAt: null, updatedBy: actor.id })
      .where(and(eq(clients.id, id), eq(clients.version, expectedVersion)))
      .returning({ id: clients.id });

    const outcome = expectUnchanged(changed.length);
    if (!outcome.ok) return outcome;

    await record(tx, actor, {
      action: "client.restored",
      entityType: "client",
      entityId: id,
      entityLabel: client.name,
    });
    return ok(undefined);
  });
}
