import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";

import { db, schema } from "../db/index.ts";
import { uuidv7 } from "../db/id.ts";
import { canSignIn } from "../db/workrooms.ts";
import { clientAuthSecret, clientAuthUrl } from "../env.ts";
import { sendWorkroomLinkEmail } from "../emails.ts";
import { describeError, log, redactEmail } from "../log.ts";

import { workroomInvitation } from "./invitation-plugin.ts";
import { workroomRedirect } from "./redirect.ts";

/**
 * Client authentication. Everyone outside the company.
 *
 * A second Better Auth instance, not a second library and not a fork. It shares
 * the database connection with the staff instance and nothing else: its own
 * tables, its own cookie name, its own secret, its own base URL, its own API
 * path and its own rate-limit table. A client session cannot satisfy a Studio
 * guard and a Studio session cannot open a Workroom, because neither instance
 * knows the other's cookie name or can verify its signature.
 *
 * The rule this exists to make structural is in docs/client-auth.md:
 *
 *   a client is never a row in `user`.
 */

const SESSION_DAYS = 30;
const MAGIC_LINK_MINUTES = 15;

function createClientAuth() {
  return betterAuth({
    appName: "Yiddi Weller Workrooms",
    baseURL: clientAuthUrl(),
    basePath: "/api/client-auth",
    secret: clientAuthSecret(),

    database: drizzleAdapter(db(), { provider: "pg", schema }),

    /**
     * Every core model renamed. The Drizzle adapter resolves a model against
     * the schema export of that name, so these are export names in
     * `lib/db/schema.ts` rather than table names — the tables underneath are
     * `client_identities`, `client_sessions` and so on.
     */
    account: { modelName: "clientCredential" },
    verification: { modelName: "clientVerification" },

    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: "yw_client",
      /**
       * Host-scoped, with no `domain` attribute. A cookie set for
       * `.yiddiweller.com` would be sent to `studio.yiddiweller.com` on every
       * request, putting a client credential in front of staff software.
       *
       * Scoped by host rather than by path, so a future `/pay` flow on the same
       * public origin can reuse the identity without a cookie migration.
       */
      useSecureCookies: process.env.NODE_ENV === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    },

    user: {
      modelName: "clientIdentity",
      additionalFields: {
        // Ours, not Better Auth's, and neither is writable through its API.
        contactId: { type: "string", input: false, required: true },
        status: { type: "string", defaultValue: "active", input: false },
      },
    },

    session: {
      modelName: "clientSession",
      expiresIn: 60 * 60 * 24 * SESSION_DAYS,
      updateAge: 60 * 60 * 24,
    },

    /**
     * Database-backed rather than the in-memory default, so the counters
     * survive a deploy and would survive a second instance. Its own table:
     * both instances expose `/sign-in/magic-link`, and the limiter keys by
     * path and address, so one shared table would let a staff sign-in and a
     * client sign-in from the same office spend each other's allowance.
     */
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "clientRateLimit",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/magic-link": { window: 300, max: 5 },
        "/magic-link/verify": { window: 300, max: 10 },
        "/workroom-invitation/accept": { window: 300, max: 10 },
      },
    },

    emailAndPassword: { enabled: false },
    socialProviders: {},

    hooks: {
      /**
       * A client authentication flow may only ever land inside the client
       * world.
       *
       * Better Auth already refuses a `callbackURL` on another origin, a
       * protocol-relative one and a `javascript:` one — measured. What it
       * cannot know is that on *this* origin, `/studio` is a different product
       * with a different identity system. A same-origin `/studio/...` callback
       * is harmless today (the public host answers 404 and Studio would ask for
       * a staff session anyway), but relying on host routing for that is
       * relying on something two files away.
       *
       * So the rule is stated where it belongs: anything that is not a path
       * under `/workrooms` becomes `/workrooms`.
       */
      before: createAuthMiddleware(async (ctx) => {
        // Both halves of the flow carry one: the sign-in POST in its body, and
        // the verification GET in its query string. Measured — sanitising only
        // the body left `/magic-link/verify?callbackURL=/studio/clients`
        // redirecting a client straight out of their own world.
        const body = ctx.body as { callbackURL?: unknown } | undefined;
        if (body && typeof body.callbackURL === "string") {
          body.callbackURL = workroomRedirect(body.callbackURL);
        }

        const query = ctx.query as { callbackURL?: unknown } | undefined;
        if (query && typeof query.callbackURL === "string") {
          query.callbackURL = workroomRedirect(query.callbackURL);
        }
      }),
    },

    plugins: [
      magicLink({
        expiresIn: 60 * MAGIC_LINK_MINUTES,
        // Nothing but an accepted invitation creates a client identity.
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          /**
           * The Build 002 lesson, applied to people outside the company.
           *
           * `disableSignUp` refuses to CREATE an identity when a link is
           * verified. It does not stop the link being SENT: Better Auth mails
           * whatever address was typed into the form and only turns it away on
           * arrival. That would leave this endpoint able to send Yiddi Weller
           * branded mail to any address in the world, and would make the
           * response tell the sender whether that address has access.
           *
           * So the answer is decided here, and returning quietly rather than
           * throwing is the point: the caller sees the same page either way.
           */
          const allowed = await canSignIn(email);
          if (!allowed) {
            log.info("client.login_refused", { email: redactEmail(email) });
            return;
          }

          /**
           * A delivery failure must not change the response either.
           *
           * Measured: letting this throw turned a real address into a 500 and
           * an unknown one into a 200, which tells anybody who asks which
           * addresses work with us — the very thing the check above exists to
           * prevent. The person sees the same page; we get the log line.
           */
          try {
            await sendWorkroomLinkEmail({ to: email, url, minutes: MAGIC_LINK_MINUTES });
            log.info("client.login_requested", { email: redactEmail(email) });
          } catch (cause) {
            log.error("client.login_delivery_failed", {
              email: redactEmail(email),
              error: describeError(cause),
            });
          }
        },
      }),
      workroomInvitation(),
      nextCookies(),
    ],
  });
}

let instance: ReturnType<typeof createClientAuth> | null = null;

/** Created on first use, for the same reason the database connection is. */
export function clientAuth() {
  if (!instance) instance = createClientAuth();
  return instance;
}
