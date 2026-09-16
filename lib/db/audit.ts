import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import {
  auditEvents,
  user,
  type AuditActorType,
  type AuditEntityType,
} from "./schema.ts";

/**
 * Who changed what, and when. Append-only, in the same transaction as the
 * change it describes.
 *
 * The policy — including what may never be written into `metadata` — is in
 * `docs/audit.md`. The short version: this records *that* something changed,
 * never a second copy of what it said. No notes, no messages, no descriptions,
 * no tokens.
 *
 * There is no update and no delete in this module, and PostgreSQL refuses both
 * anyway through the `audit_events_append_only` trigger.
 */

/**
 * Who caused an event.
 *
 * `kind` defaults to the staff case because that is every event Builds 001–003
 * ever wrote. A client actor's id belongs to `client_identities`, a different
 * table from `user`, so it is written to a different column — the schema
 * refuses a row that claims one and carries the other.
 */
export type AuditActor = { id: string; name: string; kind?: AuditActorType };

/** The studio itself, for an event no person pressed a button for. */
export const SYSTEM_ACTOR: AuditActor = {
  id: "",
  name: "Yiddi Weller",
  kind: "anonymous_session",
};

export type AuditEvent = {
  action: string;
  entityType: AuditEntityType;
  entityId?: string | null;
  /** A safe label: a name or a title. Never free text somebody wrote. */
  entityLabel?: string | null;
  metadata?: Record<string, unknown>;
};

/**
 * Writes one event inside the caller's transaction, so a change and its record
 * of it cannot drift apart: if the change rolls back, so does this.
 */
export async function record(tx: Tx, actor: AuditActor, event: AuditEvent): Promise<void> {
  const kind = actor.kind ?? "team_user";

  await tx.insert(auditEvents).values({
    id: uuidv7(),
    actorType: kind,
    actorId: kind === "team_user" ? actor.id : null,
    clientActorId: kind === "client_user" ? actor.id : null,
    // Snapshot, so the log still reads after someone leaves the studio.
    actorName: actor.name,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    entityLabel: event.entityLabel ?? null,
    metadata: event.metadata ?? {},
  });
}

/**
 * The fields an edit touched — the names, never the values. `notes`, `summary`
 * and their kind are reported as changed without being copied, which is the
 * whole point.
 */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter((key) => {
    const from = before[key as keyof T];
    const to = after[key as keyof T];
    if (from instanceof Date || to instanceof Date) {
      return String(from instanceof Date ? from.toISOString() : from) !==
        String(to instanceof Date ? to.toISOString() : to);
    }
    return from !== to;
  });
}

/* ------------------------------------------------------------------ reading */

export type AuditRow = {
  id: string;
  occurredAt: Date;
  actorKind: AuditActorType;
  actorName: string | null;
  action: string;
  entityType: AuditEntityType;
  entityId: string | null;
  entityLabel: string | null;
  metadata: Record<string, unknown>;
};

export type AuditFilter = {
  actorId?: string | null;
  entityType?: AuditEntityType | null;
  action?: string | null;
  from?: Date | null;
  to?: Date | null;
  page?: number;
  pageSize?: number;
};

export async function listAuditEvents(
  filter: AuditFilter = {},
): Promise<{ rows: AuditRow[]; total: number }> {
  const pageSize = filter.pageSize ?? 50;
  const page = filter.page ?? 1;

  const where: SQL[] = [];
  if (filter.actorId) where.push(eq(auditEvents.actorId, filter.actorId));
  if (filter.entityType) where.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.action) where.push(eq(auditEvents.action, filter.action));
  if (filter.from) where.push(gte(auditEvents.occurredAt, filter.from));
  if (filter.to) where.push(lte(auditEvents.occurredAt, filter.to));
  const clause = where.length > 0 ? and(...where) : undefined;

  const [rows, [count]] = await Promise.all([
    db()
      .select({
        id: auditEvents.id,
        occurredAt: auditEvents.occurredAt,
        actorKind: auditEvents.actorType,
        actorName: auditEvents.actorName,
        action: auditEvents.action,
        entityType: auditEvents.entityType,
        entityId: auditEvents.entityId,
        entityLabel: auditEvents.entityLabel,
        metadata: auditEvents.metadata,
      })
      .from(auditEvents)
      .where(clause)
      .orderBy(desc(auditEvents.occurredAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db().select({ n: sql<number>`count(*)::int` }).from(auditEvents).where(clause),
  ]);

  return { rows: rows as AuditRow[], total: count?.n ?? 0 };
}

/** The history of one record, for a detail page. */
export async function listEntityAudit(
  entityType: AuditEntityType,
  entityId: string,
  limit = 12,
): Promise<AuditRow[]> {
  const rows = await db()
    .select({
      id: auditEvents.id,
      occurredAt: auditEvents.occurredAt,
      actorKind: auditEvents.actorType,
      actorName: auditEvents.actorName,
      action: auditEvents.action,
      entityType: auditEvents.entityType,
      entityId: auditEvents.entityId,
      entityLabel: auditEvents.entityLabel,
      metadata: auditEvents.metadata,
    })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, entityType), eq(auditEvents.entityId, entityId)))
    .orderBy(desc(auditEvents.occurredAt))
    .limit(limit);
  return rows as AuditRow[];
}

/** The distinct actions and actors present, for the filter controls. */
export async function auditFilterOptions(): Promise<{
  actions: string[];
  actors: { id: string; name: string }[];
}> {
  const [actions, actors] = await Promise.all([
    db()
      .selectDistinct({ action: auditEvents.action })
      .from(auditEvents)
      .orderBy(auditEvents.action),
    db()
      .selectDistinct({ id: user.id, name: user.name })
      .from(user)
      .orderBy(user.name),
  ]);
  return { actions: actions.map((a) => a.action), actors };
}
