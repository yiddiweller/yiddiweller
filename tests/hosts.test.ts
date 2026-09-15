import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

/**
 * Host classification: which of the two worlds a request belongs to.
 *
 * Each case runs in its own Node process, because SITE_ENV is a build input,
 * not a request input: `lib/env.ts` reads it once when the module is evaluated,
 * exactly as a deployed image does. Re-importing inside one process would test
 * a module that had already made up its mind. A child process per scenario is
 * what a separate deployment actually is.
 */

type Kind = "studio" | "public" | "internal";

function classify(env: Record<string, string>, hosts: string[]): Kind[] {
  const script = `
    const { classifyHost } = await import("./lib/hosts.ts");
    process.stdout.write(JSON.stringify(${JSON.stringify(hosts)}.map(classifyHost)));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, SITE_ENV: "", STUDIO_HOST: "", ...env },
    encoding: "utf8",
  });
  return JSON.parse(out) as Kind[];
}

test("production serves the public site, and nothing else", () => {
  assert.deepEqual(
    classify({}, ["yiddiweller.com", "www.yiddiweller.com", "YIDDIWELLER.COM:443"]),
    ["public", "public", "public"],
  );
});

test("an unrecognised production host is public, never internal", () => {
  // A Railway-generated hostname, or any other name pointed at the deployment.
  // Falling through to `public` is the safe direction: the failure mode of
  // guessing wrong must never be exposing Studio.
  assert.deepEqual(classify({}, ["yiddiweller-production.up.railway.app"]), ["public"]);
});

test("the Studio host owns its root once STUDIO_HOST is set", () => {
  const env = { STUDIO_HOST: "studio.yiddiweller.com" };
  assert.deepEqual(
    classify(env, ["studio.yiddiweller.com", "Studio.YiddiWeller.com:443", "yiddiweller.com"]),
    ["studio", "studio", "public"],
    "host matching ignores case and port; the public host is unaffected",
  );
});

test("the beta preview is where Studio lives while the subdomain is disconnected", () => {
  // Beta runs on the hostname Railway generated and has no custom domain, so
  // the preview flag has to be what decides this, not the address. Asserted
  // with the real hostname and with two names beta does not use, because the
  // day that generated name changes must not be the day Studio disappears.
  assert.deepEqual(
    classify({ SITE_ENV: "preview" }, [
      "yiddiwellerbeta.up.railway.app",
      "yiddiwellerbeta.up.railway.app:443",
      "anything-railway-renames-it-to.up.railway.app",
    ]),
    ["internal", "internal", "internal"],
  );
});

test("without the preview flag, that same host is public and Studio is not there", () => {
  // The other half of the rule: a Railway hostname is not internal by virtue of
  // being a Railway hostname. Production is reachable at one too.
  assert.deepEqual(classify({}, ["yiddiwellerbeta.up.railway.app"]), ["public"]);
});

test("local development is internal", () => {
  assert.deepEqual(classify({}, ["localhost:3000", "127.0.0.1:3000", "yw.localhost", ""]), [
    "internal",
    "internal",
    "internal",
    "internal",
  ]);
});

test("Studio paths resolve only where Studio has no host of its own", async () => {
  const { studioPathAllowed, STUDIO_PREFIX } = await import("../lib/hosts.ts");

  // The public host must 404 rather than redirect: it gives no signal that
  // Studio exists behind it. The Studio host reaches Studio by rewrite from its
  // own root, so it does not need the path allowed either.
  assert.equal(studioPathAllowed("public"), false);
  assert.equal(studioPathAllowed("studio"), false);
  assert.equal(studioPathAllowed("internal"), true);
  assert.equal(STUDIO_PREFIX, "/studio");
});
