import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

import { acceptWorkroomInvitation, workroomForSpentInvitation } from "../db/workrooms.ts";
import { log } from "../log.ts";

import { checkAttempts, clearAttempts, recordRefusal } from "./invite-attempts.ts";

/**
 * Accepting a Workroom invitation, as an endpoint on the client auth instance.
 *
 * **Why a plugin rather than a server action.** Acceptance has to end with the
 * person signed in — asking a client to click a link, confirm, and then wait
 * for a *second* email would be software happening to somebody. Issuing that
 * session means creating a session row and writing a signed cookie, and neither
 * of those is something to hand-roll. Inside a Better Auth endpoint both are
 * the library's own: `internalAdapter.createSession` and `setSessionCookie`,
 * the same two calls its magic-link plugin makes.
 *
 * **Why POST.** Mail security scanners and link previewers open URLs before a
 * person does. An invitation that burned itself on a GET would be spent before
 * the client ever saw it, so the link renders a confirmation page and this
 * endpoint — a deliberate press — consumes it.
 *
 * Everything the acceptance means in business terms happens in one PostgreSQL
 * transaction inside `acceptWorkroomInvitation`: claim the invitation, create
 * or reuse the identity, grant the membership, write the audit event and the
 * client-safe activity. The session is issued only after that commits.
 */
export function workroomInvitation() {
  return {
    id: "workroom-invitation",
    endpoints: {
      acceptWorkroomInvitation: createAuthEndpoint(
        "/workroom-invitation/accept",
        {
          method: "POST",
          body: z.object({
            token: z.string().min(1),
            name: z.string().max(160).optional(),
          }),
        },
        async (ctx) => {
          /**
           * Logged before anything is decided, and this line is the diagnosis.
           *
           * Two rounds of beta investigation went into a failure that looked
           * identical from outside whichever layer produced it. There are three,
           * and their logs now tell them apart without anybody guessing:
           *
           *   no `attempted`              rejected in front of this handler —
           *                               the rate limiter, which never reaches
           *                               here and so could never log
           *   `attempted` + `rejected`    a business refusal, with its reason
           *   `attempted`, no `accepted`  the acceptance committed and issuing
           *                               the session then failed
           *
           * It carries nothing about who or what: no token, no address, no id.
           */
          log.info("workroom.invite_accept_attempted", {});

          const token = ctx.body.token;

          /**
           * The budget that governs an ordinary person is the **invitation's**,
           * not their address's. See `invite-attempts.ts` for why, and for what
           * beta cost before it was.
           *
           * A token nobody has failed against has no counter, so a freshly
           * resent invitation is usable on its first tap however badly the
           * previous one went.
           */
          const budget = await checkAttempts(token);
          if (!budget.ok) {
            log.info("workroom.invite_accept_throttled", {
              retry_after: budget.retryAfterSeconds,
            });
            throw new APIError(
              "TOO_MANY_REQUESTS",
              {
                message: "That link has been tried too many times.",
                code: "TOO_MANY_ATTEMPTS",
                retryAfter: budget.retryAfterSeconds,
              },
              { "Retry-After": String(budget.retryAfterSeconds) },
            );
          }

          const outcome = await acceptWorkroomInvitation({
            token,
            name: ctx.body.name ?? "",
          });

          if (!outcome.ok) {
            /**
             * A browser that sent one press twice.
             *
             * The first consumed the invitation and signed them in; the second
             * arrives to find it used. Answering that with "this cannot be
             * used" is false at the exact moment it worked — so if the caller
             * already holds a session for the Contact this invitation was
             * issued to, they are simply told where to go.
             *
             * Nothing is mutated, nothing is consumed and no session is issued.
             * Single use is untouched: the acceptance above already refused.
             */
            if (outcome.reason === "already_used") {
              const session = await getSessionFromCtx(ctx).catch(() => null);
              const contactId = (session?.user as { contactId?: unknown } | undefined)?.contactId;

              if (typeof contactId === "string") {
                const publicId = await workroomForSpentInvitation(token, contactId);
                if (publicId) {
                  log.info("workroom.invite_accept_repeated", {});
                  return ctx.json({ workroom: publicId });
                }
              }
            }

            /**
             * `invalid` means the token matches no invitation at all, so there
             * is no invitation to charge — and every random token fingerprints
             * differently, which is exactly why spraying is the address-level
             * backstop's problem rather than this budget's.
             */
            if (outcome.reason !== "invalid") await recordRefusal(token);

            log.info("workroom.invite_accept_rejected", { reason: outcome.reason });
            // One status and one shape for every refusal. **Which** refusal it
            // was travels in `code`, because the page the person is standing on
            // can say it accurately and telling them nothing sent them back to
            // the studio for a link that would have failed the same way.
            throw new APIError("BAD_REQUEST", {
              message: "That invitation cannot be used.",
              code: outcome.reason.toUpperCase(),
            });
          }

          /**
           * From here the acceptance has **committed**: the invitation is
           * spent, the membership is live, and the identity exists. A failure
           * now is not a failure to accept — it is a failure to sign somebody
           * in to something they already have.
           *
           * So it gets its own code rather than a bare 500, because the honest
           * next step is the opposite of the one a refusal needs: their access
           * is real and a sign-in link will work. Being told "that invitation
           * cannot be used" here would be false.
           */
          // Spent, so its counter protects nothing. Cleared before the session
          // is issued, so a failure there cannot leave a budget behind either.
          await clearAttempts(token);

          try {
            const identity = await ctx.context.internalAdapter.findUserById(outcome.identityId);
            if (!identity) throw new Error("identity missing immediately after acceptance");

            // Headers are picked up from the ambient endpoint context, exactly as the
            // magic-link plugin does it.
            const session = await ctx.context.internalAdapter.createSession(identity.id);
            await setSessionCookie(ctx, { session, user: identity });
          } catch (cause) {
            log.error("workroom.invite_session_failed", {
              error: cause instanceof Error ? `${cause.name}: ${cause.message}` : "unknown error",
            });
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Your access is ready, but signing you in failed.",
              code: "SESSION_FAILED",
            });
          }

          log.info("workroom.invite_accepted", {});

          return ctx.json({ workroom: outcome.publicId });
        },
      ),
    },
  } as const;
}
