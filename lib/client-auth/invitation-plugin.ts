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
          const outcome = await acceptWorkroomInvitation({
            token: ctx.body.token,
            name: ctx.body.name ?? "",
          });

          if (!outcome.ok) {
            log.info("workroom.invite_accept_rejected", { reason: outcome.reason });
            // One status and one shape for every refusal. Which of expired,
            // revoked, already used or never real it was is told on the page
            // the person came from, not by this endpoint's response.
            throw new APIError("BAD_REQUEST", {
              message: "That invitation cannot be used.",
              code: outcome.reason.toUpperCase(),
            });
          }

          const identity = await ctx.context.internalAdapter.findUserById(outcome.identityId);
          if (!identity) {
            throw new APIError("INTERNAL_SERVER_ERROR", { message: "Sign-in failed." });
          }

          // Headers are picked up from the ambient endpoint context, exactly as the
          // magic-link plugin does it.
          const session = await ctx.context.internalAdapter.createSession(identity.id);
          await setSessionCookie(ctx, { session, user: identity });

          log.info("workroom.invite_accepted", {});

          return ctx.json({ workroom: outcome.publicId });
        },
      ),
    },
  } as const;
}
