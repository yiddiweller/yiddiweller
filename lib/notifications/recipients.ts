import { receivedDedupeKey, requestedDedupeKey } from "./dedupe.ts";
import { KIND_RECIPIENT, type NotificationKind } from "./vocabulary.ts";

/**
 * Who hears about what, in V1 (G1). Pure: the eligible people arrive as
 * identifiers already read from the database, and what leaves is the rows a
 * transaction would insert. **Not called by anything yet** — G2 wires it.
 *
 *   review.requested  every eligible active client member of the Workroom
 *   review.received   the studio inbox — `CONTACT_EMAIL`, read at send time;
 *                     never a project owner, the person who asked, or every
 *                     member of staff
 *
 * **Nobody is told about their own action.** V1's two kinds cannot reach the
 * person who caused them — staff ask clients, clients write to the studio —
 * but the rule is enforced here regardless, so a kind added later cannot
 * quietly break it.
 */

export type Recipient = { kind: "client"; clientIdentityId: string } | { kind: "studio_inbox" };

/** Whoever did the thing. The studio inbox is never an actor. */
export type NotificationActor = { side: "client"; identityId: string } | { side: "studio"; userId: string };

/** Whether this recipient is the person who caused the event. */
export function isSelf(recipient: Recipient, actor: NotificationActor): boolean {
  return recipient.kind === "client" && actor.side === "client" && recipient.clientIdentityId === actor.identityId;
}

/** Everybody but the actor, each once. */
export function withoutSelf(recipients: Recipient[], actor: NotificationActor): Recipient[] {
  const seen = new Set<string>();
  return recipients.filter((recipient) => {
    if (isSelf(recipient, actor)) return false;
    const key = recipient.kind === "client" ? `client:${recipient.clientIdentityId}` : "studio_inbox";
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The rows one event would enqueue: intent only — no address, no words. */
export type DeliveryIntent = {
  kind: NotificationKind;
  workroomId: string;
  presentationReviewId: string;
  requestedAt: Date | null;
  noteNumber: number | null;
  recipientKind: Recipient["kind"];
  clientIdentityId: string | null;
  dedupeKey: string;
};

/**
 * A round asked for: one row per eligible client member of its Workroom, for
 * this request episode, never for the person who asked.
 */
export function requestedIntents(input: {
  workroomId: string;
  reviewId: string;
  requestedAt: Date;
  eligibleClientIdentityIds: string[];
  actor: NotificationActor;
}): DeliveryIntent[] {
  const recipients = withoutSelf(
    input.eligibleClientIdentityIds.map((clientIdentityId) => ({ kind: "client" as const, clientIdentityId })),
    input.actor,
  );
  return recipients.map((recipient) => {
    const clientIdentityId = recipient.kind === "client" ? recipient.clientIdentityId : "";
    return {
      kind: "review.requested",
      workroomId: input.workroomId,
      presentationReviewId: input.reviewId,
      requestedAt: input.requestedAt,
      noteNumber: null,
      recipientKind: KIND_RECIPIENT["review.requested"],
      clientIdentityId,
      dedupeKey: requestedDedupeKey({ reviewId: input.reviewId, requestedAt: input.requestedAt, clientIdentityId }),
    };
  });
}

/**
 * A round's first feedback: one row, to the studio inbox — and none at all if
 * the actor somehow were the inbox, which no person can be.
 */
export function receivedIntents(input: {
  workroomId: string;
  reviewId: string;
  noteNumber: number;
  actor: NotificationActor;
}): DeliveryIntent[] {
  const recipients = withoutSelf([{ kind: "studio_inbox" }], input.actor);
  return recipients.map(() => ({
    kind: "review.received",
    workroomId: input.workroomId,
    presentationReviewId: input.reviewId,
    requestedAt: null,
    noteNumber: input.noteNumber,
    recipientKind: KIND_RECIPIENT["review.received"],
    clientIdentityId: null,
    dedupeKey: receivedDedupeKey({ reviewId: input.reviewId }),
  }));
}
