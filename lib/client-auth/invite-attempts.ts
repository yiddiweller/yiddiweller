import { createHash } from "node:crypto";

import { and, eq, lt, like, sql } from "drizzle-orm";

import { db } from "../db/index.ts";
import { uuidv7 } from "../db/id.ts";
import { clientRateLimit } from "../db/schema.ts";

/**
 * How many times one invitation may be refused before it stops answering.
 *
 * **Scoped to the invitation, not to the address it was tapped from.** The
 * address is the wrong key for this: a client on a phone shares a carrier NAT
 * with thousands of strangers, a resent invitation carries a new token and
 * deserves a clean slate, and the person tapping already holds a 32-byte
 * random credential — which is the thing worth counting against.
 *
 * Beta proved the cost of getting that wrong. Ten taps per address per five
 * minutes meant a client who tapped, failed, and tapped again — the obvious
 * thing to do — locked themselves out of every invitation for five minutes,
 * including ones that had not been sent yet.
 *
 * ## The numbers
 *
 * **Ten refusals in five minutes, per invitation.** A person double-tapping or
 * reloading produces a handful; ten deterministic refusals means the link is
 * dead and tapping it again will never change that. It is a courtesy limit
 * against a retry loop, not a guessing defence — guessing a 256-bit token is
 * not a thing any budget needs to make harder.
 *
 * Cleared entirely by a successful acceptance, because after that the
 * invitation is spent and its counter protects nothing.
 */
const WINDOW_MS = 5 * 60 * 1000;
const MAX_REFUSALS = 10;

/**
 * The key, which is a fingerprint of the token and never the token.
 *
 * Deliberately **not** `hashToken`'s digest, which is what
 * `workroom_invitations.token_hash` stores. Two reasons. A rate-limit table is
 * operational data with looser handling than a credential store, and it should
 * not be joinable against the invitations it counts. And an entry here means
 * only "somebody tapped something"; it should not double as a lookup key for
 * which invitation that was.
 *
 * Namespaced with `inv:` so it can never collide with Better Auth's own
 * `address|path` keys in the same table.
 */
export function attemptKey(token: string): string {
  const digest = createHash("sha256").update(`workroom-invitation-attempt:${token}`).digest("hex");
  return `inv:${digest.slice(0, 32)}`;
}

export type AttemptCheck = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Whether this invitation may be tried again.
 *
 * A token nobody has failed against has no row and always passes — which is
 * why a freshly resent invitation is usable immediately, and why a random
 * token is not slowed down here at all. Random tokens are the broad
 * address-level backstop's problem; each one fingerprints differently, so no
 * per-invitation budget could ever see them as related.
 */
export async function checkAttempts(token: string, now: Date = new Date()): Promise<AttemptCheck> {
  const [row] = await db()
    .select({ count: clientRateLimit.count, lastRequest: clientRateLimit.lastRequest })
    .from(clientRateLimit)
    .where(eq(clientRateLimit.key, attemptKey(token)))
    .limit(1);

  if (!row) return { ok: true };

  const elapsed = now.getTime() - row.lastRequest;
  if (elapsed >= WINDOW_MS) return { ok: true };
  if (row.count < MAX_REFUSALS) return { ok: true };

  return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)) };
}

/**
 * Count one refusal against this invitation.
 *
 * The window is rolled inside the statement rather than read first and written
 * second: two taps arriving together would otherwise both see a stale row and
 * both reset the count to one.
 */
export async function recordRefusal(token: string, now: Date = new Date()): Promise<void> {
  const cutoff = now.getTime() - WINDOW_MS;

  await db()
    .insert(clientRateLimit)
    .values({
      id: uuidv7(now.getTime()),
      key: attemptKey(token),
      count: 1,
      lastRequest: now.getTime(),
    })
    .onConflictDoUpdate({
      target: clientRateLimit.key,
      set: {
        count: sql`CASE WHEN ${clientRateLimit.lastRequest} < ${cutoff} THEN 1 ELSE ${clientRateLimit.count} + 1 END`,
        lastRequest: now.getTime(),
      },
    });
}

/**
 * Forget this invitation's refusals, and sweep any that have gone cold.
 *
 * Called on a successful acceptance, which is the one moment that is both rare
 * and certain to happen on a healthy system — so the table is tidied without a
 * scheduled job, and without a sweep running on the hot path of every tap. The
 * sweep is confined to this module's own namespace and never touches Better
 * Auth's rows for the sign-in and magic-link endpoints.
 */
export async function clearAttempts(token: string, now: Date = new Date()): Promise<void> {
  await db().delete(clientRateLimit).where(eq(clientRateLimit.key, attemptKey(token)));

  await db()
    .delete(clientRateLimit)
    .where(
      and(
        like(clientRateLimit.key, "inv:%"),
        lt(clientRateLimit.lastRequest, now.getTime() - WINDOW_MS),
      ),
    );
}

/** Read for tests and for the report; never for a decision. */
export const ATTEMPT_LIMITS = { windowMs: WINDOW_MS, maxRefusals: MAX_REFUSALS } as const;
