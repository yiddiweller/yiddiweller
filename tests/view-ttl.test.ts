import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { after, before, test } from "node:test";

import { resetStorage } from "../lib/storage/client.ts";
import { headObject, presignGet, presignInline, presignPreview, presignPut } from "../lib/storage/presign.ts";
import {
  effectiveViewTtlSeconds,
  readViewTtlOverride,
  VIEW_TTL_OVERRIDE_KEY,
  VIEW_TTL_OVERRIDE_MIN,
  VIEW_TTL_SECONDS,
} from "../lib/storage/view-ttl.ts";
import { presignedExpired, S3Stub, useStub } from "./support/s3-stub.ts";

/**
 * Stage F6.1: how long a signed view URL lives, and a test bucket that
 * actually lets one expire — without waiting fifteen minutes for anything.
 */

const stub = new S3Stub();
const saved = { override: process.env[VIEW_TTL_OVERRIDE_KEY], site: process.env.SITE_ENV };

before(async () => {
  useStub(await stub.start());
  resetStorage();
  stub.place("w/one/f/two/original", Buffer.from("the bytes of a file"), "audio/wav");
});

after(async () => {
  restoreEnv();
  resetStorage();
  await stub.stop();
});

function restoreEnv() {
  if (saved.override === undefined) delete process.env[VIEW_TTL_OVERRIDE_KEY];
  else process.env[VIEW_TTL_OVERRIDE_KEY] = saved.override;
  if (saved.site === undefined) delete process.env.SITE_ENV;
  else process.env.SITE_ENV = saved.site;
}

const preview = (value: string | undefined) => ({ SITE_ENV: "preview", ...(value === undefined ? {} : { [VIEW_TTL_OVERRIDE_KEY]: value }) });
const expiresOf = (url: string) => Number(new URL(url).searchParams.get("X-Amz-Expires"));

/* ------------------------------------------------------------ the rule */

test("the view TTL is fifteen minutes, and with no override it is exactly that", () => {
  assert.equal(VIEW_TTL_SECONDS, 900);
  assert.equal(VIEW_TTL_OVERRIDE_MIN, 30);
  assert.equal(VIEW_TTL_OVERRIDE_KEY, "VIEW_TTL_OVERRIDE_SECONDS");
  assert.equal(effectiveViewTtlSeconds({}), 900);
  assert.equal(effectiveViewTtlSeconds({ SITE_ENV: "preview" }), 900);
  assert.deepEqual(readViewTtlOverride({}), { status: "absent" });
});

test("in the preview, a whole number of seconds from 30 to 900 shortens it", () => {
  for (const [value, seconds] of [
    ["30", 30],
    ["60", 60],
    ["899", 899],
    ["900", 900],
    [" 60 ", 60],
  ] as const) {
    assert.equal(effectiveViewTtlSeconds(preview(value)), seconds, JSON.stringify(value));
    assert.deepEqual(readViewTtlOverride(preview(value)), { status: "applied", seconds });
  }
});

test("nothing can lengthen it, and anything unreadable leaves the default", () => {
  for (const value of [
    "901",
    "1800",
    "86400",
    "999999",
    "9999999",
    "0",
    "29",
    "1",
    "-30",
    "-900",
    "30.5",
    "60.0",
    "1e3",
    "0x3c",
    "060",
    "+60",
    "sixty",
    "60s",
    "NaN",
    "Infinity",
    "",
    "   ",
    "6 0",
  ]) {
    assert.deepEqual(readViewTtlOverride(preview(value)), { status: "invalid" }, JSON.stringify(value));
    assert.equal(effectiveViewTtlSeconds(preview(value)), 900, JSON.stringify(value));
  }
  // Whatever it says, the answer never exceeds fifteen minutes.
  for (let i = 0; i < 2000; i += 1) {
    const value = String(Math.floor(Math.random() * 1e7) - 5e6);
    assert.ok(effectiveViewTtlSeconds(preview(value)) <= 900, value);
    assert.ok(effectiveViewTtlSeconds(preview(value)) >= 30, value);
  }
});

test("outside the preview it is ignored entirely — production is never shortened", () => {
  for (const env of [
    { [VIEW_TTL_OVERRIDE_KEY]: "30" },
    { [VIEW_TTL_OVERRIDE_KEY]: "30", SITE_ENV: "" },
    { [VIEW_TTL_OVERRIDE_KEY]: "30", SITE_ENV: "production" },
    { [VIEW_TTL_OVERRIDE_KEY]: "30", SITE_ENV: "Preview" },
    { [VIEW_TTL_OVERRIDE_KEY]: "garbage" },
  ]) {
    assert.deepEqual(readViewTtlOverride(env), { status: "ignored_outside_preview" }, JSON.stringify(env));
    assert.equal(effectiveViewTtlSeconds(env), 900, JSON.stringify(env));
  }
});

/* ------------------------------------------------------- through the SDK */

test("a view URL is signed for the effective TTL; downloads, previews and uploads keep theirs", async () => {
  try {
    delete process.env[VIEW_TTL_OVERRIDE_KEY];
    delete process.env.SITE_ENV;
    assert.equal(expiresOf(await presignInline("w/one/f/two/original", "audio/wav")), 900);

    process.env.SITE_ENV = "preview";
    process.env[VIEW_TTL_OVERRIDE_KEY] = "30";
    assert.equal(expiresOf(await presignInline("w/one/f/two/original", "audio/wav")), 30);
    // Only viewing is shortened.
    assert.equal(expiresOf(await presignGet("w/one/f/two/original", "two.wav")), 60, "download");
    assert.equal(expiresOf(await presignPreview("w/one/f/two/preview")), 60, "preview");
    assert.equal(expiresOf(await presignPut("pending/x", "audio/wav")), 900, "upload");

    process.env[VIEW_TTL_OVERRIDE_KEY] = "86400";
    assert.equal(expiresOf(await presignInline("w/one/f/two/original", "audio/wav")), 900, "lengthened");

    delete process.env.SITE_ENV;
    process.env[VIEW_TTL_OVERRIDE_KEY] = "30";
    assert.equal(expiresOf(await presignInline("w/one/f/two/original", "audio/wav")), 900, "shortened outside the preview");
  } finally {
    restoreEnv();
  }
});

/* ------------------------------------------------------ the stub expires */

test("the test bucket serves a signed view URL until it expires, then answers 403 like S3", async () => {
  const realNow = () => Date.now();
  try {
    process.env.SITE_ENV = "preview";
    process.env[VIEW_TTL_OVERRIDE_KEY] = "30";
    stub.now = realNow;

    const first = await presignInline("w/one/f/two/original", "audio/wav");
    const fresh = await fetch(first);
    assert.equal(fresh.status, 200);
    assert.equal(await fresh.text(), "the bytes of a file");

    // Still inside its thirty seconds: bytes, and ranges.
    stub.now = () => realNow() + 20_000;
    assert.equal((await fetch(first)).status, 200);
    const range = await fetch(first, { headers: { range: "bytes=4-8" } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "bytes");

    // Past it: refused, for a whole read and a range alike.
    stub.now = () => realNow() + 31_000;
    const expired = await fetch(first);
    assert.equal(expired.status, 403);
    assert.match(await expired.text(), /<Code>AccessDenied<\/Code><Message>Request has expired<\/Message>/);
    assert.equal((await fetch(first, { headers: { range: "bytes=4-8" } })).status, 403);

    // A URL signed now is good again — and expires in its turn.
    stub.now = realNow;
    // (SigV4 is deterministic: signed within the same second, it may even be
    // the same string — what matters is that it is dated now.)
    const second = await presignInline("w/one/f/two/original", "audio/wav");
    assert.equal((await fetch(second)).status, 200);
    stub.now = () => realNow() + 31_000;
    assert.equal((await fetch(second)).status, 403);

    // Requests the SDK signs with a header, not a query, never expire here.
    stub.now = () => realNow() + 86_400_000;
    const facts = await headObject("w/one/f/two/original");
    assert.equal(facts?.size, "the bytes of a file".length);
  } finally {
    stub.now = realNow;
    restoreEnv();
  }
});

test("only a presigned URL can expire, and one naming an unreadable date is refused", () => {
  const at = Date.UTC(2026, 8, 25, 12, 0, 0);
  const url = (q: string) => new URL(`http://stub/test-bucket/key?${q}`);
  assert.equal(presignedExpired(url(""), at), false, "no signature at all");
  assert.equal(presignedExpired(url("X-Amz-Expires=30"), at), false, "no date");
  assert.equal(presignedExpired(url("X-Amz-Date=20260925T120000Z"), at), false, "no lifetime");
  assert.equal(presignedExpired(url("X-Amz-Date=20260925T120000Z&X-Amz-Expires=30"), at + 30_000), false, "at the last moment");
  assert.equal(presignedExpired(url("X-Amz-Date=20260925T120000Z&X-Amz-Expires=30"), at + 30_001), true, "a moment after");
  assert.equal(presignedExpired(url("X-Amz-Date=yesterday&X-Amz-Expires=30"), at), true);
  assert.equal(presignedExpired(url("X-Amz-Date=20260925T120000Z&X-Amz-Expires=-1"), at), true);
});

/* ------------------------------------------------------------ env:check */

function envCheck(extra: Record<string, string | undefined>) {
  const base: Record<string, string> = {
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
  const env = { ...base } as Record<string, string>;
  for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
  const run = spawnSync(process.execPath, ["scripts/check-env.mjs"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: run.status, out: `${run.stdout}${run.stderr}` };
}

test("env:check refuses the override anywhere that is not the preview, and never prints its value", () => {
  const clean = envCheck({});
  assert.equal(clean.status, 0, clean.out);
  assert.match(clean.out, /unset\s+VIEW_TTL_OVERRIDE_SECONDS \(beta test aid\)/);

  for (const site of [undefined, "", "production", "Preview"]) {
    const refused = envCheck({ VIEW_TTL_OVERRIDE_SECONDS: "777", SITE_ENV: site });
    assert.equal(refused.status, 1, `SITE_ENV=${site}: ${refused.out}`);
    assert.match(refused.out, /VIEW_TTL_OVERRIDE_SECONDS is set outside the preview/);
    assert.doesNotMatch(refused.out, /777/, "the value was printed");
  }
  // Even blank: present is present.
  assert.equal(envCheck({ VIEW_TTL_OVERRIDE_SECONDS: "" }).status, 1);

  const beta = envCheck({ VIEW_TTL_OVERRIDE_SECONDS: "777", SITE_ENV: "preview" });
  assert.equal(beta.status, 0, beta.out);
  assert.match(beta.out, /present\s+VIEW_TTL_OVERRIDE_SECONDS \(beta test aid: view URLs shortened, 30–900 seconds\)/);
  assert.doesNotMatch(beta.out, /777/);
});
