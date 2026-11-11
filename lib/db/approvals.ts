import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";

import { record as recordActivity } from "./activity.ts";
import { record as recordAudit, type AuditActor } from "./audit.ts";
import { db, type Tx } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { ok, refuse, type Outcome, type Refusal } from "./outcome.ts";
import type { ClientActor, StaffActor } from "./reviews.ts";
import {
  presentationApprovalApprovers,
  presentationApprovals,
  presentationRevisions,
  presentations,
  workroomMembers,
  workrooms,
} from "./schema.ts";
import {
  isApproverDecision,
  overallApprovalState,
  type ApprovalStatus,
  type ApproverDecision,
  type ApproverState,
  type DecidedOutcome,
} from "../workrooms/approval-rules.ts";
import { approvalLifecycle, type ApprovalLifecycle, type LifecycleApprover } from "../workrooms/approval-lifecycle.ts";
import {
  approvalCapabilities,
  toClientApproval,
  versionSubject,
  NO_APPROVAL_CAPABILITIES,
  type ApprovalCapabilities,
  type ClientApproval,
} from "../workrooms/approval-view.ts";

/**
 * Approvals: a formal decision about one exact published Revision, asked of
 * named client members (Stage H2, on H1's schema).
 *
 * **Every write to `presentation_approvals` and
 * `presentation_approval_approvers` goes through this module.** No route,
 * server action or component touches either table. `0008` holds everything
 * structural — the vocabulary, each status's shape, the one transition, the
 * immutability, the tenancy floor, and the agreement between a request and its
 * approvers at commit. What needs another table or the current moment is here:
 * who may ask and decide, that the Revision is current and published, who is
 * eligible, the content-hash re-check, Audit and Activity.
 *
 * ## The lock order
 *
 *     presentations → presentation_reviews → presentation_approvals
 *                   → presentation_approval_approvers → workroom_members
 *
 * Never acquired upward.
 *
 *   ask        `presentations` FOR UPDATE — the same lock a publish takes, so an
 *              ask and a publish of one Presentation serialize — then the
 *              chosen members FOR SHARE.
 *   decide     `presentations` FOR SHARE, then the request FOR UPDATE, then the
 *              decider's membership FOR SHARE. The share lock on the
 *              Presentation is what makes *decision vs publish* and *decision
 *              vs unpublish* each have one winner: both of those write the
 *              Presentation row, so they wait for an in-flight decision, and a
 *              decision waits for them. Two decisions on one request share the
 *              first lock and serialize on the second. The membership lock makes
 *              *decision vs revoke* deterministic: a revoke that committed
 *              first is seen, and a revoke that comes second waits for the
 *              decision to commit.
 *   withdraw   `presentations` FOR SHARE, then the request FOR UPDATE.
 *   publish    `presentations` FOR UPDATE (in `publishPresentation`), then the
 *              outgoing Review round, then pending requests FOR UPDATE here.
 *
 * The deferred agreement trigger in `0008` sees only committed rows and its
 * own, which is why every decision is made under the request's row lock.
 *
 * ## What reaches a browser
 *
 * Nothing in this module returns a database id to a client surface. The
 * client names a request by public handles — Workroom, Presentation, version
 * number — and receives `ClientApproval`, which carries none. Studio reaches a
 * Presentation by its own ids, as every Studio route already does.
 */

/* ----------------------------------------------------------- transaction */

/**
 * A refusal raised from inside a transaction. Returning an `Outcome` from a
 * transaction callback commits it, which is wrong once anything has been
 * written — the same device `reviews.ts` and `presentations.ts` use.
 */
class Refused extends Error {
  readonly outcome: Outcome<never>;

  constructor(outcome: Outcome<never>) {
    super("refused");
    this.name = "Refused";
    this.outcome = outcome;
  }
}

function refused(reason: Refusal, message: string): never {
  throw new Refused(refuse(reason, message));
}

async function settle<T>(work: Promise<Outcome<T>>): Promise<Outcome<T>> {
  try {
    return await work;
  } catch (cause) {
    if (cause instanceof Refused) return cause.outcome as Outcome<T>;
    throw cause;
  }
}

function rows<T>(result: unknown): T[] {
  return result as T[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same sentence for everything a client may not reach, whatever the reason. */
const UNAVAILABLE = "That approval request is not available.";

/* ------------------------------------------------------------------ actors */

function staffAudit(actor: StaffActor): AuditActor {
  return { id: actor.userId, name: actor.name, kind: "team_user" };
}

function clientAudit(actor: ClientActor): AuditActor {
  return { id: actor.identityId, name: actor.name, kind: "client_user" };
}

/* ---------------------------------------------------------------- inputs */

/** Studio names a Presentation by its own ids and a version by its number. */
export type StaffApprovalRef = { workroomId: string; presentationId: string; version: number };

/** A client names a request by public handles only. No database id, ever. */
export type ClientApprovalRef = { room: string; presentation: string; version: number };

function validStaffRef(ref: StaffApprovalRef): boolean {
  return UUID.test(ref.workroomId) && UUID.test(ref.presentationId) && Number.isInteger(ref.version) && ref.version >= 1;
}

/* ------------------------------------------------------------ eligibility */

/**
 * Who may be named on a request in this Workroom right now: an active sign-in,
 * an unarchived Contact, and active access. The Workroom's and the
 * Presentation's own state are checked by the caller, once.
 */
const ELIGIBLE_MEMBERS = (workroomId: string) => sql`
  SELECT m.id AS "memberId", ci.id AS "identityId", c.name AS "name"
    FROM workroom_members m
    JOIN contacts c ON c.id = m.contact_id AND c.archived_at IS NULL
    JOIN client_identities ci ON ci.contact_id = m.contact_id AND ci.status = 'active'
   WHERE m.workroom_id = ${workroomId} AND m.status = 'active'
`;

export type EligibleApprover = { memberId: string; name: string };

/**
 * The people Studio's Ask dialog may offer (H3), by membership id and name.
 * Studio is staff-only and reaches a Workroom by id, as it does everywhere; the
 * ids chosen here come back to `askForApproval`, which re-resolves every one of
 * them inside this Workroom under lock rather than trusting it.
 */
export async function eligibleApprovers(workroomId: string): Promise<EligibleApprover[]> {
  if (!UUID.test(workroomId)) return [];
  const found = rows<{ memberId: string; identityId: string; name: string }>(
    await db().execute(sql`${ELIGIBLE_MEMBERS(workroomId)} ORDER BY c.name, m.id`),
  );
  return found.map((row) => ({ memberId: row.memberId, name: row.name }));
}

/* -------------------------------------------------------------------- ask */

export type AskedApproval = {
  /** The version asked about. */
  version: number;
  /** How many people were named. Never who — nothing here names an identity. */
  approvers: number;
};

/**
 * Ask named client members to approve the version the client is reading.
 *
 * `version` is the number the studio was looking at. If a newer one has been
 * published since, the request is refused rather than silently moved onto work
 * nobody chose to put in front of an approver.
 *
 * `memberIds` are Workroom membership ids, re-resolved here: each must be an
 * active member **of this Workroom** with an active sign-in and an unarchived
 * Contact. One that is not — another Workroom's, a revoked one, a guess —
 * refuses the whole request; nobody is quietly left out. Duplicates are refused
 * before the database's own uniqueness would.
 *
 * One transaction: the request, its approvers, Audit, Activity. `requested_at`
 * is the database's own `now()` — `0008` names approvers only in the
 * transaction that made the request, and proves it by that equality. No email.
 */
export async function askForApproval(
  actor: StaffActor,
  ref: StaffApprovalRef,
  memberIds: string[],
): Promise<Outcome<AskedApproval>> {
  // A type is not a guard: a client actor cast into the studio's shape must not
  // be able to ask on the studio's behalf.
  if ((actor as { side: string }).side !== "studio" || !actor.userId) {
    return refuse("not_found", "That presentation no longer exists.");
  }
  if (!validStaffRef(ref)) return refuse("not_found", "That presentation no longer exists.");
  if (memberIds.length === 0) return refuse("invalid", "Choose at least one person to ask.");
  if (new Set(memberIds).size !== memberIds.length) {
    return refuse("invalid", "Each person can only be asked once.");
  }
  if (!memberIds.every((id) => UUID.test(id))) {
    return refuse("invalid", "Everyone asked must have active access to this workroom.");
  }

  return settle(
    db().transaction(async (tx): Promise<Outcome<AskedApproval>> => {
      // The publish lock, so an ask and a publish of this Presentation cannot
      // interleave, and two asks cannot both see "nothing stands here yet".
      const locked = rows<{ id: string }>(
        await tx.execute(sql`
          SELECT id FROM presentations
           WHERE id = ${ref.presentationId} AND workroom_id = ${ref.workroomId}
           FOR UPDATE
        `),
      );
      if (locked.length === 0) refused("not_found", "That presentation no longer exists.");

      const [world] = await tx
        .select({
          title: presentations.title,
          status: presentations.status,
          archivedAt: presentations.archivedAt,
          currentRevisionId: presentations.currentRevisionId,
          workroomStatus: workrooms.status,
          workroomArchivedAt: workrooms.archivedAt,
        })
        .from(presentations)
        .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
        .where(eq(presentations.id, ref.presentationId))
        .limit(1);

      if (!world) refused("not_found", "That presentation no longer exists.");
      if (world.workroomArchivedAt || world.workroomStatus !== "published") {
        refused("blocked", "Open this workroom to the client before asking for approval in it.");
      }
      if (world.archivedAt) refused("blocked", "Restore this presentation first.");
      if (world.status !== "published" || !world.currentRevisionId) {
        refused("blocked", "Publish this presentation before asking for approval on it.");
      }

      const [current] = await tx
        .select({
          id: presentationRevisions.id,
          number: presentationRevisions.revisionNumber,
          contentHash: presentationRevisions.contentHash,
        })
        .from(presentationRevisions)
        .where(eq(presentationRevisions.id, world.currentRevisionId))
        .limit(1);

      if (!current) refused("not_found", "That version no longer exists.");
      if (current.number !== ref.version) {
        refused("blocked", `Ask for approval on the version the client is reading — Version ${current.number}.`);
      }

      // At most one request per Revision that is not withdrawn (0008's index).
      // Said in the domain first, so the answer is a sentence, not an error.
      const [standing] = await tx
        .select({ status: presentationApprovals.status })
        .from(presentationApprovals)
        .where(
          and(
            eq(presentationApprovals.presentationRevisionId, current.id),
            ne(presentationApprovals.status, "withdrawn"),
          ),
        )
        .limit(1);

      if (standing) {
        if (standing.status === "requested") {
          refused("already_done", "Approval has already been asked for on this version.");
        }
        if (standing.status === "approved") refused("blocked", "This version is already approved.");
        if (standing.status === "changes_requested") {
          refused("blocked", "Changes were requested on this version. Publish a new version to ask again.");
        }
        refused("blocked", "A newer version replaced this one.");
      }

      // Every chosen person, re-resolved inside this Workroom, and held: a
      // revoke that commits first is seen here; one that comes second waits.
      const chosen = rows<{ memberId: string; identityId: string; name: string }>(
        await tx.execute(sql`
          ${ELIGIBLE_MEMBERS(ref.workroomId)}
             AND m.id IN (${sql.join(memberIds.map((id) => sql`${id}`), sql`, `)})
           ORDER BY c.name, m.id
           FOR SHARE OF m
        `),
      );

      if (chosen.length !== memberIds.length) {
        refused("invalid", "Everyone asked must have active access to this workroom.");
      }

      const [earlier] = await tx
        .select({ n: count() })
        .from(presentationApprovals)
        .where(eq(presentationApprovals.presentationRevisionId, current.id));

      const id = uuidv7();
      // `status` and `requested_at` are the database's defaults, deliberately.
      await tx.insert(presentationApprovals).values({
        id,
        workroomId: ref.workroomId,
        presentationRevisionId: current.id,
        requestedBy: actor.userId,
        contentHash: current.contentHash,
      });

      await tx.insert(presentationApprovalApprovers).values(
        chosen.map((person) => ({
          id: uuidv7(),
          workroomId: ref.workroomId,
          presentationApprovalId: id,
          clientIdentityId: person.identityId,
          displayName: person.name,
        })),
      );

      await recordAudit(tx, staffAudit(actor), {
        action: "approval.requested",
        entityType: "presentation_approval",
        entityId: id,
        entityLabel: world.title,
        metadata: {
          workroom_id: ref.workroomId,
          revision: current.number,
          approvers: chosen.length,
          ...(Number(earlier?.n ?? 0) > 0 ? { after: "withdrawn" } : {}),
        },
      });

      // Once per Revision, when it is first asked about. Asking again after a
      // withdrawal is the studio's administration, not the client's news —
      // and "approval was requested" stays true either way. The Reviews rule.
      if (Number(earlier?.n ?? 0) === 0) {
        await recordActivity(tx, ref.workroomId, {
          kind: "approval.requested",
          subject: versionSubject(world.title, current.number),
        });
      }

      return ok({ version: current.number, approvers: chosen.length });
    }),
  );
}

/* --------------------------------------------------------------- withdraw */

export type WithdrawnApproval = { version: number; decided: number; approvers: number };

/**
 * Take back a request that is still awaiting a decision.
 *
 * Terminal for that request; the Revision may be asked again. Every approver
 * row stays, and so does every decision already made on it — submitted
 * decisions are immutable history and are never erased or rewritten. A request
 * that already ended (approved, changes requested, superseded) cannot be
 * withdrawn, and a second press on one already withdrawn is a calm
 * `already_done`. No Activity: the client's timeline is not told about the
 * studio's administration.
 */
export async function withdrawApproval(
  actor: StaffActor,
  ref: StaffApprovalRef,
): Promise<Outcome<WithdrawnApproval>> {
  if ((actor as { side: string }).side !== "studio" || !actor.userId) {
    return refuse("not_found", "That presentation no longer exists.");
  }
  if (!validStaffRef(ref)) return refuse("not_found", "That presentation no longer exists.");

  return settle(
    db().transaction(async (tx): Promise<Outcome<WithdrawnApproval>> => {
      const presentation = rows<{ title: string }>(
        await tx.execute(sql`
          SELECT title FROM presentations
           WHERE id = ${ref.presentationId} AND workroom_id = ${ref.workroomId}
           FOR SHARE
        `),
      );
      if (presentation.length === 0) refused("not_found", "That presentation no longer exists.");

      const target = rows<{ id: string; status: ApprovalStatus }>(
        await tx.execute(sql`
          SELECT a.id, a.status
            FROM presentation_approvals a
            JOIN presentation_revisions r ON r.id = a.presentation_revision_id
           WHERE r.presentation_id = ${ref.presentationId}
             AND r.workroom_id = ${ref.workroomId}
             AND r.revision_number = ${ref.version}
           ORDER BY (a.status <> 'withdrawn') DESC, a.requested_at DESC
           LIMIT 1
        `),
      );
      if (target.length === 0) refused("not_found", "There is no approval request on this version.");

      // The request's own lock, then its state as of now.
      const [held] = rows<{ status: ApprovalStatus; workroomId: string }>(
        await tx.execute(sql`
          SELECT status, workroom_id AS "workroomId" FROM presentation_approvals
           WHERE id = ${target[0]!.id}
           FOR UPDATE
        `),
      );

      switch (held!.status) {
        case "withdrawn":
          refused("already_done", "That request was already withdrawn.");
          break;
        case "approved":
          refused("blocked", "This version was approved. A decision is never taken back.");
          break;
        case "changes_requested":
          refused("blocked", "Changes were requested on this version. A decision is never taken back.");
          break;
        case "superseded":
          refused("blocked", "That request closed when a newer version was published.");
          break;
        case "requested":
          break;
      }

      await tx
        .update(presentationApprovals)
        .set({ status: "withdrawn", closedAt: sql`now()`, closedByUserId: actor.userId })
        .where(and(eq(presentationApprovals.id, target[0]!.id), eq(presentationApprovals.status, "requested")));

      const decisions = await approverStates(tx, target[0]!.id);
      const decided = decisions.filter((state) => state !== null).length;

      await recordAudit(tx, staffAudit(actor), {
        action: "approval.withdrawn",
        entityType: "presentation_approval",
        entityId: target[0]!.id,
        entityLabel: presentation[0]!.title,
        metadata: {
          workroom_id: held!.workroomId,
          revision: ref.version,
          approvers: decisions.length,
          decided,
        },
      });

      return ok({ version: ref.version, decided, approvers: decisions.length });
    }),
  );
}

async function approverStates(tx: Tx, approvalId: string): Promise<ApproverState[]> {
  const found = await tx
    .select({ decision: presentationApprovalApprovers.decision })
    .from(presentationApprovalApprovers)
    .where(eq(presentationApprovalApprovers.presentationApprovalId, approvalId));
  return found.map((row) => row.decision ?? null);
}

/* ----------------------------------------------------------------- decide */

export type ApprovalDecided = {
  decision: ApproverDecision;
  /** Where the request stands after this decision. */
  outcome: DecidedOutcome;
  version: number;
};

/**
 * Where a client's handles point: the standing request on that exact version,
 * found only through an active membership of a published, unarchived Workroom
 * and a published, unarchived Presentation. A wrong Workroom, Presentation or
 * version, a revoked membership and a hidden Presentation all produce the same
 * null — the Reviews discipline: concealment over explanation.
 */
async function standingRequestForViewer(
  contactId: string,
  ref: ClientApprovalRef,
): Promise<{ approvalId: string; presentationId: string } | null> {
  if (!Number.isInteger(ref.version) || ref.version < 1) return null;
  const found = rows<{ approvalId: string; presentationId: string }>(
    await db().execute(sql`
      SELECT a.id AS "approvalId", p.id AS "presentationId"
        FROM presentation_approvals a
        JOIN presentation_revisions r ON r.id = a.presentation_revision_id
        JOIN presentations p ON p.id = r.presentation_id AND p.workroom_id = r.workroom_id
        JOIN workrooms w ON w.id = p.workroom_id
        JOIN workroom_members m ON m.workroom_id = w.id
       WHERE w.public_id = ${ref.room} AND w.status = 'published' AND w.archived_at IS NULL
         AND m.contact_id = ${contactId} AND m.status = 'active'
         AND p.public_id = ${ref.presentation} AND p.status = 'published' AND p.archived_at IS NULL
         AND r.revision_number = ${ref.version}
         AND a.status <> 'withdrawn'
       LIMIT 1
    `),
  );
  return found[0] ?? null;
}

/**
 * A named approver decides: `approved` or `changes_requested`, once, with no
 * reason required.
 *
 * In order, inside one transaction: the Presentation's share lock, the
 * request's row lock, then — re-read under it — the request still awaiting,
 * the Workroom and Presentation still live, its Revision still current, the
 * actor named and still undecided, their sign-in, Contact and membership still
 * standing (the membership held FOR SHARE), and the content hash still the
 * Revision's own. Then the decision, the request's overall state from every
 * approver's (`overallApprovalState`), Audit, and Activity only when the request
 * ends. A second press finds the decision already made and changes nothing.
 */
export async function decideApproval(
  actor: ClientActor,
  ref: ClientApprovalRef,
  decision: ApproverDecision,
): Promise<Outcome<ApprovalDecided>> {
  // A Studio session is nobody here, whatever shape it arrives in.
  if ((actor as { side: string }).side !== "client" || !actor.identityId || !actor.contactId) {
    return refuse("not_found", UNAVAILABLE);
  }
  if (!isApproverDecision(decision)) {
    return refuse("invalid", "Choose Approve or Request changes.");
  }

  const located = await standingRequestForViewer(actor.contactId, ref);
  if (!located) return refuse("not_found", UNAVAILABLE);

  return settle(
    db().transaction(async (tx): Promise<Outcome<ApprovalDecided>> => {
      await tx.execute(sql`SELECT id FROM presentations WHERE id = ${located.presentationId} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM presentation_approvals WHERE id = ${located.approvalId} FOR UPDATE`);

      const [request] = rows<{
        status: ApprovalStatus;
        workroomId: string;
        revisionId: string;
        contentHash: string;
        revisionHash: string;
        version: number;
        title: string;
        presentationStatus: string;
        presentationArchived: boolean;
        currentRevisionId: string | null;
        workroomStatus: string;
        workroomArchived: boolean;
      }>(
        await tx.execute(sql`
          SELECT a.status, a.workroom_id AS "workroomId", a.presentation_revision_id AS "revisionId",
                 a.content_hash AS "contentHash", r.content_hash AS "revisionHash",
                 r.revision_number AS "version", p.title,
                 p.status AS "presentationStatus", (p.archived_at IS NOT NULL) AS "presentationArchived",
                 p.current_revision_id AS "currentRevisionId",
                 w.status AS "workroomStatus", (w.archived_at IS NOT NULL) AS "workroomArchived"
            FROM presentation_approvals a
            JOIN presentation_revisions r ON r.id = a.presentation_revision_id
            JOIN presentations p ON p.id = r.presentation_id
            JOIN workrooms w ON w.id = a.workroom_id
           WHERE a.id = ${located.approvalId}
        `),
      );
      if (!request) refused("not_found", UNAVAILABLE);

      switch (request.status) {
        case "approved":
        case "changes_requested":
          refused("already_done", "This version has already been decided.");
          break;
        case "withdrawn":
          refused("blocked", "The studio withdrew this request.");
          break;
        case "superseded":
          refused("blocked", "A newer version was published, so this request has closed.");
          break;
        case "requested":
          break;
      }

      // Hidden, unpublished or archived: nothing to decide on, and nothing
      // said about why. An unpublished Presentation's pending request waits.
      if (request.workroomStatus !== "published" || request.workroomArchived) refused("not_found", UNAVAILABLE);
      if (request.presentationStatus !== "published" || request.presentationArchived) {
        refused("not_found", UNAVAILABLE);
      }
      if (request.currentRevisionId !== request.revisionId) {
        refused("blocked", "A newer version was published, so this request has closed.");
      }

      const [mine] = await tx
        .select({
          id: presentationApprovalApprovers.id,
          decision: presentationApprovalApprovers.decision,
          name: presentationApprovalApprovers.displayName,
        })
        .from(presentationApprovalApprovers)
        .where(
          and(
            eq(presentationApprovalApprovers.presentationApprovalId, located.approvalId),
            eq(presentationApprovalApprovers.clientIdentityId, actor.identityId),
          ),
        )
        .limit(1);

      if (!mine) refused("blocked", "You were not asked to approve this version.");
      if (mine.decision !== null) refused("already_done", "You have already decided on this version.");

      // Still allowed to decide, and held so a revoke cannot land mid-decision:
      // a revoke that committed first is seen (the row no longer matches), and
      // one that comes second waits for this commit.
      const standing = rows<{ id: string }>(
        await tx.execute(sql`
          SELECT m.id
            FROM workroom_members m
            JOIN contacts c ON c.id = m.contact_id AND c.archived_at IS NULL
            JOIN client_identities ci ON ci.contact_id = m.contact_id
                 AND ci.id = ${actor.identityId} AND ci.status = 'active'
           WHERE m.workroom_id = ${request.workroomId}
             AND m.contact_id = ${actor.contactId}
             AND m.status = 'active'
           FOR SHARE OF m
        `),
      );
      if (standing.length === 0) refused("not_found", UNAVAILABLE);

      // The integrity tripwire. Revisions are immutable, so this can only
      // differ if something rewrote a row that cannot be rewritten — refused
      // and said loudly, never repaired.
      if (request.contentHash !== request.revisionHash) {
        console.error(JSON.stringify({ level: "error", event: "approval.hash_mismatch", version: request.version }));
        refused("blocked", "This version can no longer be verified, so it cannot be decided. Ask the studio to publish it again.");
      }

      const decided = await tx
        .update(presentationApprovalApprovers)
        .set({ decision, decidedAt: sql`now()` })
        .where(and(eq(presentationApprovalApprovers.id, mine.id), isNull(presentationApprovalApprovers.decision)))
        .returning({ id: presentationApprovalApprovers.id });
      if (decided.length === 0) refused("already_done", "You have already decided on this version.");

      const states = await approverStates(tx, located.approvalId);
      const outcome = overallApprovalState(states);

      if (outcome !== "requested") {
        await tx
          .update(presentationApprovals)
          .set({ status: outcome, closedAt: sql`now()` })
          .where(and(eq(presentationApprovals.id, located.approvalId), eq(presentationApprovals.status, "requested")));
      }

      await recordAudit(tx, clientAudit(actor), {
        action: decision === "approved" ? "approval.approved" : "approval.changes_requested",
        entityType: "presentation_approval",
        entityId: located.approvalId,
        entityLabel: request.title,
        metadata: { workroom_id: request.workroomId, revision: request.version, outcome },
      });

      // Only when the request ends. A partial approval is not news yet.
      if (outcome === "approved") {
        await recordActivity(tx, request.workroomId, {
          kind: "approval.approved",
          // One approver: their name. Several: the request's outcome, which no
          // single person's name would describe accurately.
          actorLabel: states.length === 1 ? mine.name : null,
          subject: versionSubject(request.title, request.version),
        });
      } else if (outcome === "changes_requested") {
        await recordActivity(tx, request.workroomId, {
          kind: "approval.changes_requested",
          actorLabel: mine.name,
          subject: versionSubject(request.title, request.version),
        });
      }

      return ok({ decision, outcome, version: request.version });
    }),
  );
}

/* ------------------------------------------------------------- supersede */

/**
 * Publishing a newer Revision closes any request still awaiting a decision on
 * an older one. **Terminally**, and inside `publishPresentation`'s
 * transaction, which already holds the `presentations` lock and has already
 * dealt with the outgoing Review round — so this is third in the lock order.
 *
 * Every approver row and every partial decision stays exactly as it was. A
 * request that already ended — approved, changes requested, withdrawn,
 * superseded — is not touched. The new Revision begins with no request:
 * nothing carries forward. This is also how a request left pending by an
 * unpublish is resolved: the next publish supersedes it.
 */
export async function supersedeApprovalsOnPublish(
  tx: Tx,
  actor: AuditActor,
  presentationId: string,
  incomingRevisionId: string,
  incomingNumber: number,
  title: string,
): Promise<void> {
  // FOR UPDATE re-evaluates the WHERE after any wait, so a request a decision
  // ended a moment ago drops out here rather than being superseded.
  const pending = rows<{ id: string; workroomId: string; version: number }>(
    await tx.execute(sql`
      SELECT a.id, a.workroom_id AS "workroomId", r.revision_number AS "version"
        FROM presentation_approvals a
        JOIN presentation_revisions r ON r.id = a.presentation_revision_id
       WHERE r.presentation_id = ${presentationId}
         AND a.presentation_revision_id <> ${incomingRevisionId}
         AND a.status = 'requested'
       ORDER BY a.id
       FOR UPDATE OF a
    `),
  );

  for (const request of pending) {
    await tx
      .update(presentationApprovals)
      .set({ status: "superseded", closedAt: sql`now()`, closedByRevisionId: incomingRevisionId })
      .where(and(eq(presentationApprovals.id, request.id), eq(presentationApprovals.status, "requested")));

    const states = await approverStates(tx, request.id);
    await recordAudit(tx, actor, {
      action: "approval.superseded",
      entityType: "presentation_approval",
      entityId: request.id,
      entityLabel: title,
      metadata: {
        workroom_id: request.workroomId,
        revision: request.version,
        by_revision: incomingNumber,
        approvers: states.length,
        decided: states.filter((state) => state !== null).length,
      },
    });
  }
}

/* ------------------------------------------------------------------ reads */

type RequestRow = {
  id: string;
  status: ApprovalStatus;
  requestedAt: Date;
  closedAt: Date | null;
  closedByRevisionId: string | null;
};

type ApproverRow = {
  identityId: string;
  name: string;
  decision: ApproverState;
  decidedAt: Date | null;
};

/** Every request on one Revision, newest first. */
async function requestsOn(revisionId: string): Promise<RequestRow[]> {
  const found = await db()
    .select({
      id: presentationApprovals.id,
      status: presentationApprovals.status,
      requestedAt: presentationApprovals.requestedAt,
      closedAt: presentationApprovals.closedAt,
      closedByRevisionId: presentationApprovals.closedByRevisionId,
    })
    .from(presentationApprovals)
    .where(eq(presentationApprovals.presentationRevisionId, revisionId))
    .orderBy(desc(presentationApprovals.requestedAt), desc(presentationApprovals.id));
  return found as RequestRow[];
}

async function approversOf(approvalId: string): Promise<ApproverRow[]> {
  const found = await db()
    .select({
      identityId: presentationApprovalApprovers.clientIdentityId,
      name: presentationApprovalApprovers.displayName,
      decision: presentationApprovalApprovers.decision,
      decidedAt: presentationApprovalApprovers.decidedAt,
    })
    .from(presentationApprovalApprovers)
    .where(eq(presentationApprovalApprovers.presentationApprovalId, approvalId))
    .orderBy(asc(presentationApprovalApprovers.displayName), asc(presentationApprovalApprovers.id));
  return found.map((row) => ({ ...row, decision: row.decision ?? null }));
}

/** Which Revision number ended a request, when one did. Never its id. */
async function numberOf(revisionId: string | null): Promise<number | null> {
  if (!revisionId) return null;
  const [row] = await db()
    .select({ number: presentationRevisions.revisionNumber })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, revisionId))
    .limit(1);
  return row?.number ?? null;
}

/**
 * The request a client should see on a Revision: the standing one, or else the
 * most recent withdrawn one that somebody had already answered. A withdrawn
 * request nobody answered is as good as never made, to the client.
 */
async function requestToShow(requests: RequestRow[]): Promise<{ request: RequestRow; approvers: ApproverRow[] } | null> {
  const standing = requests.find((r) => r.status !== "withdrawn");
  if (standing) return { request: standing, approvers: await approversOf(standing.id) };
  for (const request of requests) {
    const approvers = await approversOf(request.id);
    if (approvers.some((a) => a.decision !== null)) return { request, approvers };
  }
  return null;
}

/** Which of these identities can still decide in this Workroom right now. */
async function stillEligible(workroomId: string, identityIds: string[]): Promise<Set<string>> {
  if (identityIds.length === 0) return new Set();
  const found = rows<{ identityId: string }>(
    await db().execute(sql`
      ${ELIGIBLE_MEMBERS(workroomId)}
         AND ci.id IN (${sql.join(identityIds.map((id) => sql`${id}`), sql`, `)})
    `),
  );
  return new Set(found.map((row) => row.identityId));
}

export type ClientApprovalPanel = { approval: ClientApproval; capabilities: ApprovalCapabilities };

/**
 * Everything a client's Approval surface may render for one exact Revision —
 * or null, the client's whole vocabulary for *there is nothing here*.
 *
 * Membership is part of the query, not a check after it. Null covers: never
 * asked, withdrawn before anybody answered, a Revision this person may not
 * open, and somebody else's Workroom — indistinguishable, deliberately.
 * `revisionNumber` omitted means the current Revision.
 */
export async function approvalPanelForViewer(
  viewer: { contactId: string; identityId: string },
  room: string,
  presentation: string,
  revisionNumber?: number,
): Promise<ClientApprovalPanel | null> {
  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      revisionId: presentationRevisions.id,
      version: presentationRevisions.revisionNumber,
      currentRevisionId: presentations.currentRevisionId,
      workroomId: workrooms.id,
    })
    .from(presentationRevisions)
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .innerJoin(workroomMembers, eq(workroomMembers.workroomId, workrooms.id))
    .where(
      and(
        wanted,
        eq(workrooms.publicId, room),
        eq(workrooms.status, "published"),
        isNull(workrooms.archivedAt),
        eq(workroomMembers.contactId, viewer.contactId),
        eq(workroomMembers.status, "active"),
        eq(presentations.publicId, presentation),
        eq(presentations.status, "published"),
        isNull(presentations.archivedAt),
      ),
    )
    .limit(1);

  if (!row) return null;

  const shown = await requestToShow(await requestsOn(row.revisionId));
  if (!shown) return null;

  const approval = toClientApproval({
    status: shown.request.status,
    version: row.version,
    requestedAt: shown.request.requestedAt,
    closedAt: shown.request.closedAt,
    supersededByVersion: await numberOf(shown.request.closedByRevisionId),
    approvers: shown.approvers.map((a) => ({
      name: a.name,
      decision: a.decision,
      decidedAt: a.decidedAt,
      isViewer: a.identityId === viewer.identityId,
    })),
  });
  if (!approval) return null;

  const mine = shown.approvers.find((a) => a.identityId === viewer.identityId);
  const eligible = mine ? (await stillEligible(row.workroomId, [viewer.identityId])).has(viewer.identityId) : false;

  return {
    approval,
    capabilities: approvalCapabilities({
      status: shown.request.status,
      pendingForViewer: Boolean(mine && mine.decision === null),
      current: row.currentRevisionId === row.revisionId,
      // The query above already required a published, unarchived Workroom and
      // Presentation; a hidden one never reaches this line.
      live: true,
      eligible,
    }),
  };
}

export type StaffApprovalPanel = {
  /** The public number of the Revision read, or null when there is none. */
  revision: number | null;
  /**
   * What the client sees for this Revision, in the client's own shape — Studio
   * reads the same projection, as with Reviews. Null when the client sees
   * nothing (never asked, or withdrawn before anybody answered).
   */
  approval: ClientApproval | null;
  /** Studio's administration of it. No other world receives this. */
  lifecycle: ApprovalLifecycle;
};

/**
 * One Revision's approval, for staff: the client's projection plus the
 * lifecycle. Starts from the Revision, because the state Studio most needs is
 * the one where no request exists yet. Staff reach a Presentation through its
 * own Workroom, unpublished included — looking at your own unpublished work is
 * what Studio is for. `revisionNumber` omitted means the current Revision.
 */
export async function approvalPanelForStaff(
  workroomId: string,
  presentationId: string,
  revisionNumber?: number,
): Promise<StaffApprovalPanel> {
  const nothing: StaffApprovalPanel = {
    revision: null,
    approval: null,
    lifecycle: approvalLifecycle({
      status: null,
      supersededByVersion: null,
      approvers: [],
      withdrawnBefore: 0,
      current: false,
      live: false,
      anyEligible: false,
    }),
  };
  if (!UUID.test(workroomId) || !UUID.test(presentationId)) return nothing;

  const wanted =
    revisionNumber === undefined
      ? eq(presentationRevisions.id, presentations.currentRevisionId)
      : and(
          eq(presentationRevisions.presentationId, presentations.id),
          eq(presentationRevisions.revisionNumber, revisionNumber),
        );

  const [row] = await db()
    .select({
      revisionId: presentationRevisions.id,
      version: presentationRevisions.revisionNumber,
      currentRevisionId: presentations.currentRevisionId,
      presentationStatus: presentations.status,
      presentationArchivedAt: presentations.archivedAt,
      workroomStatus: workrooms.status,
      workroomArchivedAt: workrooms.archivedAt,
    })
    .from(presentationRevisions)
    .innerJoin(presentations, eq(presentations.id, presentationRevisions.presentationId))
    .innerJoin(workrooms, eq(workrooms.id, presentations.workroomId))
    .where(and(wanted, eq(presentations.id, presentationId), eq(presentations.workroomId, workroomId)))
    .limit(1);

  if (!row) return nothing;

  const live =
    row.presentationStatus === "published" &&
    row.presentationArchivedAt === null &&
    row.workroomStatus === "published" &&
    row.workroomArchivedAt === null;
  const current = row.currentRevisionId === row.revisionId;
  const anyEligible = (await eligibleApprovers(workroomId)).length > 0;

  const requests = await requestsOn(row.revisionId);
  const latest = requests[0] ?? null;
  const approvers = latest ? await approversOf(latest.id) : [];
  const eligibleNow = await stillEligible(
    workroomId,
    approvers.map((a) => a.identityId),
  );

  const lifecycleApprovers: LifecycleApprover[] = approvers.map((a) => ({
    name: a.name,
    decision: a.decision,
    decidedAt: a.decidedAt,
    eligible: eligibleNow.has(a.identityId),
  }));

  const shown = await requestToShow(requests);
  const approval = shown
    ? toClientApproval({
        status: shown.request.status,
        version: row.version,
        requestedAt: shown.request.requestedAt,
        closedAt: shown.request.closedAt,
        supersededByVersion: await numberOf(shown.request.closedByRevisionId),
        approvers: shown.approvers.map((a) => ({
          name: a.name,
          decision: a.decision,
          decidedAt: a.decidedAt,
          isViewer: false,
        })),
      })
    : null;

  return {
    revision: row.version,
    approval,
    lifecycle: approvalLifecycle({
      status: latest?.status ?? null,
      supersededByVersion: await numberOf(latest?.closedByRevisionId ?? null),
      approvers: lifecycleApprovers,
      withdrawnBefore: requests.filter((r) => r !== latest && r.status === "withdrawn").length,
      current,
      live,
      anyEligible,
    }),
  };
}

export type VersionApprovalState = {
  version: number;
  /** The Revision's standing outcome, or null when nothing stands on it. */
  state: Exclude<ApprovalStatus, "withdrawn"> | null;
};

/**
 * One quiet word per version for Studio's history list (H3): the standing
 * request's status on each Revision of a Presentation, oldest first.
 */
export async function approvalHistoryForStaff(
  workroomId: string,
  presentationId: string,
): Promise<VersionApprovalState[]> {
  if (!UUID.test(workroomId) || !UUID.test(presentationId)) return [];
  const found = rows<{ version: number; state: Exclude<ApprovalStatus, "withdrawn"> | null }>(
    await db().execute(sql`
      SELECT r.revision_number AS "version",
             (SELECT a.status FROM presentation_approvals a
               WHERE a.presentation_revision_id = r.id AND a.status <> 'withdrawn' LIMIT 1) AS "state"
        FROM presentation_revisions r
        JOIN presentations p ON p.id = r.presentation_id
       WHERE p.id = ${presentationId} AND p.workroom_id = ${workroomId}
       ORDER BY r.revision_number
    `),
  );
  return found.map((row) => ({ version: Number(row.version), state: row.state ?? null }));
}

/**
 * Whether publishing this Presentation now would close a request still
 * awaiting a decision — the fact H3's publish confirmation discloses, read from
 * the same column `supersedeApprovalsOnPublish` acts on. Advisory: the publish
 * re-reads under its own lock.
 */
export async function pendingApprovalOnCurrentRevision(
  workroomId: string,
  presentationId: string,
): Promise<boolean> {
  if (!UUID.test(workroomId) || !UUID.test(presentationId)) return false;
  const [row] = await db()
    .select({ id: presentationApprovals.id })
    .from(presentationApprovals)
    .innerJoin(presentations, eq(presentations.currentRevisionId, presentationApprovals.presentationRevisionId))
    .where(
      and(
        eq(presentations.id, presentationId),
        eq(presentations.workroomId, workroomId),
        eq(presentationApprovals.status, "requested"),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Re-exported so callers of this module need not reach into the rules. */
export { NO_APPROVAL_CAPABILITIES, type ApproverDecision };
