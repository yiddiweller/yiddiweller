import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";

import { acceptWorkroomInvitation } from "../db/workrooms.ts";
import { log } from "../log.ts";

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

          const outcome = await acceptWorkroomInvitation({
            token: ctx.body.token,
            name: ctx.body.name ?? "",
          });

          if (!outcome.ok) {
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
