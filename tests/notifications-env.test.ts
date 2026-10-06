import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { EMAIL } from "../lib/contact.ts";
import { notificationMode, redirectProblem } from "../lib/notifications/mode.ts";

/**
 * Stage G1: where notifications may go, as configuration. Production is live
 * and refuses `NOTIFICATION_REDIRECT_TO` by name; the preview captures by
 * default and redirects only to one well-formed address; the value is never
 * printed. And none of it touches sign-in, invitation or contact mail.
 */

const SECRET_ADDRESS = "owner-redirect-7f3a@example.test";

function envCheck(extra: Record<string, string | undefined>) {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    DATABASE_URL: "postgres://x",
    RESEND_API_KEY: "x",
    RESEND_FROM_EMAIL: "x@example.com",
    CONTACT_EMAIL: "x@example.com",
    APP_URL: "https://example.com",
    BETTER_AUTH_SECRET: "x",
    CLIENT_AUTH_URL: "https://example.com",
    CLIENT_AUTH_SECRET: "x",
  };
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  const run = spawnSync(process.execPath, ["scripts/check-env.mjs"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("production refuses NOTIFICATION_REDIRECT_TO by name — even blank — and never prints it", () => {
  const clean = envCheck({});
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /unset\s+NOTIFICATION_REDIRECT_TO \(beta test aid\)/);
  assert.doesNotMatch(clean.out, /Stage G notifications/, "production described a preview mode");

  for (const site of [undefined, "", "production", "Preview"]) {
    for (const value of [SECRET_ADDRESS, ""]) {
      const refused = envCheck({ NOTIFICATION_REDIRECT_TO: value, SITE_ENV: site });
      assert.equal(refused.status, 1, `SITE_ENV=${site}, value ${JSON.stringify(value)}: ${refused.out}`);
      assert.match(refused.out, /NOTIFICATION_REDIRECT_TO is set outside the preview/);
      assert.ok(!refused.out.includes(SECRET_ADDRESS), "the redirect address was printed");
    }
  }
});

test("the preview captures by default and says so; a valid redirect is accepted without being printed", () => {
  const capture = envCheck({ SITE_ENV: "preview" });
  assert.equal(capture.status, 0, capture.out);
  assert.match(capture.out, /Stage G notifications: captured, none sent \(preview\)\./);

  const redirect = envCheck({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: SECRET_ADDRESS });
  assert.equal(redirect.status, 0, redirect.out);
  assert.match(redirect.out, /present\s+NOTIFICATION_REDIRECT_TO \(beta test aid: every notification goes to one address\)/);
  assert.match(redirect.out, /Stage G notifications: redirected to one address \(preview\)\./);
  assert.ok(!redirect.out.includes(SECRET_ADDRESS), "the redirect address was printed");
});

test("a malformed redirect in the preview is refused, named and not quoted", () => {
  for (const malformed of ["nope", "two@example.test,three@example.test", "a b@example.test", " ", "x".repeat(250) + "@example.test"]) {
    const refused = envCheck({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: malformed });
    assert.equal(refused.status, 1, `${JSON.stringify(malformed)}: ${refused.out}`);
    assert.match(refused.out, /NOTIFICATION_REDIRECT_TO is not a single email address/);
    if (malformed.trim()) assert.ok(!refused.out.includes(malformed.trim()), "the malformed value was printed");
  }
});

test("env:check and mode.ts give one answer, and use the project's one email rule", () => {
  const values = [undefined, "", " ", SECRET_ADDRESS, ` ${SECRET_ADDRESS} `, "nope", "a@b", "a@b.co"];
  for (const site of [undefined, "preview", "production"]) {
    for (const value of values) {
      const env = { SITE_ENV: site, NOTIFICATION_REDIRECT_TO: value };
      const script = envCheck(env).status === 0;
      const problem = redirectProblem(env);
      assert.equal(script, problem === null, `SITE_ENV=${site} NOTIFICATION_REDIRECT_TO=${JSON.stringify(value)}`);
      // A configuration env:check accepts in the preview is one mode.ts would act on as written.
      if (site === "preview" && problem === null && value !== undefined) {
        assert.deepEqual(notificationMode(env), { mode: "redirect", to: value.trim() });
      }
    }
  }
  const script = readFileSync("scripts/check-env.mjs", "utf8");
  const pattern = /const EMAIL = (\/.*\/);/.exec(script)?.[1];
  assert.equal(pattern, EMAIL.toString(), "env:check's email rule drifted from lib/contact.ts");
});

test("sign-in, invitation and contact mail never consult the notification mode or transport", () => {
  const strip = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const file of [
    "lib/emails.ts",
    "lib/auth-delivery.ts",
    "lib/auth/config.ts",
    "lib/client-auth/config.ts",
    "app/api/contact/route.ts",
    "app/studio/(app)/workrooms/actions.ts",
    "app/studio/(app)/team/actions.ts",
  ]) {
    let code: string;
    try {
      code = strip(file);
    } catch {
      continue; // a file this build does not have
    }
    assert.doesNotMatch(code, /notifications\/|notificationMode|MailTransport|NOTIFICATION_REDIRECT_TO/, file);
  }
});
