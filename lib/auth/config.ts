import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";

import { db, schema } from "../db/index.ts";
import { uuidv7 } from "../db/id.ts";
import { appUrl, authSecret } from "../env.ts";
import { sendMagicLinkEmail } from "../emails.ts";
import { log, redactEmail } from "../log.ts";
import { staffForEmail } from "./access.ts";

/**
 * Studio authentication. Staff only.
 *
 * Better Auth was chosen over Auth.js because Auth.js still ships v4 as its
 * stable release while the App-Router-native v5 has been in beta for thirty-two
 * pre-releases. Better Auth is on a stable 1.x, declares Next 16 and React 19
 * in its peers, ships a first-party Drizzle adapter, and keeps identity in our
 * own database rather than at a vendor. Reasoning is recorded in
 * docs/architecture.md so it can be challenged rather than assumed.
 *
 * Sign-in is a magic link, with sign-up disabled. That is the whole access
 * model: a link can only be sent to an address that already has a user row,
 * and a user row is created only by accepting an invitation or by the one-time
 * owner bootstrap. There is no password to reset and no registration form.
 */

const SESSION_DAYS = 7;
const MAGIC_LINK_MINUTES = 10;

function createAuth() {
  return betterAuth({
    appName: "Yiddi Weller Studio",
    baseURL: appUrl(),
    secret: authSecret(),

    database: drizzleAdapter(db(), { provider: "pg", schema }),

    // Same identifier shape as every other table: time-ordered, not
    // enumerable. See the note in lib/db/schema.ts about the column type.
    advanced: {
      database: { generateId: () => uuidv7() },
      cookiePrefix: "yw_studio",
      // Host-scoped on purpose. A Studio session cookie must never be sent
      // with a request to the public site, so no domain is set and the
      // browser keeps it to the exact host that issued it.
      useSecureCookies: process.env.NODE_ENV === "production",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
      },
    },

    session: {
      expiresIn: 60 * 60 * 24 * SESSION_DAYS,
      updateAge: 60 * 60 * 24,
    },

    /**
     * Stops the sign-in endpoint becoming a way to send mail to anyone, and
     * blunts token guessing. Better Auth's own limiter rather than a second
     * inconsistent one beside the contact form's.
     */
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
      customRules: {
        "/sign-in/magic-link": { window: 300, max: 5 },
        "/magic-link/verify": { window: 300, max: 10 },
      },
    },

    // Neither is a way in. Both are disabled so the only route to a session
    // is a magic link to an already-invited address.
    emailAndPassword: { enabled: false },
    socialProviders: {},

    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "member", input: false },
        status: { type: "string", defaultValue: "active", input: false },
      },
    },

    plugins: [
      magicLink({
        expiresIn: 60 * MAGIC_LINK_MINUTES,
        // The single most important line in this file. Without it, anyone
        // who can reach the sign-in form creates themselves an account.
        disableSignUp: true,
        sendMagicLink: async ({ email, url }) => {
          // `disableSignUp` refuses to CREATE a user when a link is verified.
          // It does not stop the link being sent: Better Auth mails whatever
          // address was typed into the form, and only turns it away on
          // arrival. That leaves the sign-in endpoint able to send Yiddi
          // Weller branded mail to any address in the world, and makes the
          // response distinguishable between an address that has access and
          // one that does not.
          //
          // So the address is checked here instead. Returning quietly rather
          // than throwing is the point: the caller sees the same response
          // either way, so this cannot be used to discover who works here.
          const staff = await staffForEmail(email);
          if (!staff) {
            log.info("studio.login_refused", { email: redactEmail(email) });
            return;
          }

          await sendMagicLinkEmail({ to: email, url, minutes: MAGIC_LINK_MINUTES });
          log.info("studio.login_requested", { email: redactEmail(email) });
        },
      }),
    nextCookies(),
  ],
  });
}

let instance: ReturnType<typeof createAuth> | null = null;

export function auth() {
  if (typeof window !== "undefined") {
    throw new Error("lib/auth/config may only be used on the server.");
  }
  if (!instance) instance = createAuth();
  return instance;
}
