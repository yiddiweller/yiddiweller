import { desc, eq } from "drizzle-orm";

import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { workroomActivity, type ActivityKind } from "./schema.ts";

/**
 * What the client sees has happened in their Workroom.
 *
 * **Not the audit log.** Audit is who changed what, is read by Owners and is
 * immutable; this is curated context for people outside the company. Both are
 * written from the same business event, in the same transaction, with different
 * content, and neither reads the other as its storage. The full distinction is
 * in docs/activity.md.
 *
 * There is no `metadata` here and there is not going to be one: a row holds a
 * value from a fixed vocabulary and two short safe labels, so there is nowhere
 * for an internal note to be pasted by accident. The guarantee is structural
 * rather than a policy somebody has to remember at review time.
 *
 * There is no update and no delete in this module either. When a later change
 * contradicts an earlier event, the answer is another event.
 */

export type ActivityEvent = {
  kind: ActivityKind;
  /** A person's name as it was then. History does not rewrite itself. */
  actorLabel?: string | null;
  /** One safe word or short label — a status, a title. Never free text. */
  subject?: string | null;
};

export type ActivityRow = {
  id: string;
  occurredAt: Date;
  kind: ActivityKind;
  actorLabel: string | null;
  subject: string | null;
};

/** Writes one event inside the caller's transaction, beside its audit event. */
export async function record(
  tx: Tx,
  workroomId: string,
  event: ActivityEvent,
): Promise<void> {
  await tx.insert(workroomActivity).values({
    id: uuidv7(),
    workroomId,
    kind: event.kind,
    actorLabel: event.actorLabel ?? null,
    subject: event.subject ?? null,
  });
}

/** One Workroom's timeline, newest first. The same reader for both audiences. */
export async function listActivity(workroomId: string, limit = 50): Promise<ActivityRow[]> {
  const rows = await db()
    .select({
      id: workroomActivity.id,
      occurredAt: workroomActivity.occurredAt,
      kind: workroomActivity.kind,
      actorLabel: workroomActivity.actorLabel,
      subject: workroomActivity.subject,
    })
    .from(workroomActivity)
    .where(eq(workroomActivity.workroomId, workroomId))
    .orderBy(desc(workroomActivity.occurredAt))
    .limit(limit);

  return rows as ActivityRow[];
}
