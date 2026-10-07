import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

/**
 * The runtime image can run the operational commands (G2.1).
 *
 * Real beta found `npm run notifications:dispatch` failing in the deployed
 * container with `notification.dispatch_failed`: the runner stage copied
 * `scripts/` but not the `lib/` modules those scripts import, so the import
 * failed before anything ran. `npm run storage:sweep` had the same defect.
 * Every test on the host passed, because the host checkout has `lib/`.
 *
 * The rule the Dockerfile now states: **an operational script imports only
 * from `scripts/` and `lib/`, and the runner ships both.** Three layers hold it:
 *
 *   static       the runner stage's COPY lines and `.dockerignore`, against
 *                every script's import graph and its packages
 *   traced       the real commands, run with a load hook: every project file
 *                Node actually opens must be one the image ships
 *   container    opt-in — `RUNTIME_IMAGE=<tag>` names an image built from
 *                this Dockerfile; the commands run inside it, against this
 *                DATABASE_URL and a local stand-in for Resend
 */

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/* ------------------------------------------------------------ the image */

/** Top-level paths the runner stage puts in /app. */
function shippedPaths(): Set<string> {
  const dockerfile = read("Dockerfile");
  const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
  const shipped = new Set<string>();
  for (const line of runner.split("\n")) {
    if (!/^COPY\s/.test(line)) continue;
    const words = line.trim().split(/\s+/).slice(1).filter((word) => !word.startsWith("--"));
    const destination = words.pop()!;
    const fromStage = /--from=/.test(line);
    for (const source of fromStage ? [destination] : words) {
      shipped.add(source.replace(/^\.\//, "").replace(/\/$/, "").split("/")[0]!);
    }
  }
  return shipped;
}

/** Packages the prod-deps stage deletes after installing. */
function prunedPackages(): Set<string> {
  const match = /RUN rm -rf ((?:node_modules\/\S+\s*\\?\s*)+)/.exec(read("Dockerfile"));
  return new Set((match?.[1] ?? "").split(/\s+/).filter((w) => w.startsWith("node_modules/")).map((w) => w.slice("node_modules/".length)));
}

/** The operational entry points: every `scripts/*.mjs` a package script runs. */
function operationalScripts(): string[] {
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
  return [...new Set(Object.values(scripts).flatMap((command) => command.match(/scripts\/[\w-]+\.mjs/g) ?? []))].sort();
}

/* ---------------------------------------------------------- the graph */

// Static and dynamic imports. `import type` / `export type` are erased by
// type stripping and never load, so they are not edges.
const EDGE = /(?:^|[;\s])(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s*)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gm;

function graph(entry: string): { files: string[]; packages: string[]; aliases: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const aliases: string[] = [];
  const stack = [resolve(ROOT, entry)];
  while (stack.length) {
    const file = stack.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(EDGE)) {
      const spec = (match[1] ?? match[2])!;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        assert.ok(existsSync(target), `${relative(ROOT, file)} imports ${spec}, which does not exist`);
        stack.push(target);
      } else if (spec.startsWith("@/")) {
        aliases.push(`${relative(ROOT, file)} -> ${spec}`);
      } else if (!spec.startsWith("node:")) {
        packages.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      }
    }
  }
  return { files: [...files].map((f) => relative(ROOT, f)).sort(), packages: [...packages].sort(), aliases };
}

/* ------------------------------------------------------------- static */

test("the runner ships scripts/ and lib/, and .dockerignore hides neither", () => {
  const shipped = shippedPaths();
  for (const path of ["scripts", "lib", "node_modules", ".next", "package.json", "drizzle"]) {
    assert.ok(shipped.has(path), `the runner stage does not ship ${path}`);
  }
  for (const never of ["tests", "docs", ".git", ".env"]) {
    assert.ok(!shipped.has(never), `the runner stage ships ${never}`);
  }
  const ignored = read(".dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const needed of ["lib", "scripts", "lib/", "scripts/"]) {
    assert.ok(!ignored.includes(needed), `.dockerignore excludes ${needed}`);
  }
  for (const secret of [".env", ".env.*", "tests", "docs", ".git"]) {
    assert.ok(ignored.includes(secret), `.dockerignore no longer excludes ${secret}`);
  }
});

test("every operational script's imports ship in the runner — no alias, no omitted file, no dev package", () => {
  const shipped = shippedPaths();
  const pruned = prunedPackages();
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  const entries = operationalScripts();
  for (const expected of ["scripts/dispatch-notifications.mjs", "scripts/sweep-pending.mjs", "scripts/check-env.mjs", "scripts/migrate.mjs"]) {
    assert.ok(entries.includes(expected), `${expected} is no longer an npm script`);
  }

  for (const entry of entries) {
    const { files, packages, aliases } = graph(entry);
    assert.deepEqual(aliases, [], `${entry} reaches a Next-only path alias, which plain Node cannot resolve`);
    for (const file of files) {
      assert.ok(shipped.has(file.split("/")[0]!), `${entry} needs ${file}, which the runtime image does not contain`);
      assert.ok(!file.startsWith("tests/") && !file.startsWith("app/") && !file.startsWith("components/"), `${entry} needs ${file}`);
    }
    for (const name of packages) {
      assert.ok(name in pkg.dependencies, `${entry} imports ${name}, which is not a production dependency`);
      assert.ok(!pruned.has(name), `${entry} imports ${name}, which the prod-deps stage deletes`);
    }
  }
});

test("the dispatcher's graph is what it should be: lib/ only, and nothing from Next", () => {
  const { files, packages } = graph("scripts/dispatch-notifications.mjs");
  assert.ok(files.includes("lib/notifications/dispatch.ts"));
  assert.ok(files.every((file) => file === "scripts/dispatch-notifications.mjs" || file.startsWith("lib/")), files.join("\n"));
  assert.ok(!files.includes("lib/notifications/after-response.ts"), "the command reaches next/server's after()");
  assert.ok(!packages.includes("next") && !packages.includes("server-only") && !packages.includes("react"), packages.join(" "));
});

/* -------------------------------------------------------------- traced */

const database = process.env.DATABASE_URL;

/** Runs a command with Node's type stripping and a hook recording every project file loaded. */
function traced(script: string, env: Record<string, string | undefined>): Promise<{ code: number; loaded: string[]; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "yw-trace-"));
  const hook = join(dir, "hook.mjs");
  writeFileSync(
    hook,
    `import { registerHooks } from "node:module";
const root = ${JSON.stringify(`file://${ROOT}/`)};
registerHooks({ load(url, context, next) {
  if (url.startsWith(root) && !url.includes("/node_modules/")) process.stderr.write("LOADED " + url.slice(root.length) + "\\n");
  return next(url, context);
} });`,
  );
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--import", hook, script], {
      cwd: ROOT,
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (err += String(chunk)));
    child.on("close", (code) =>
      done({
        code: code ?? -1,
        out,
        loaded: err.split("\n").filter((l) => l.startsWith("LOADED ")).map((l) => l.slice(7)),
      }),
    );
  });
}

test("traced: every project file the dispatcher actually loads ships in the image", { skip: database ? false : "set DATABASE_URL" }, async () => {
  const shipped = shippedPaths();
  const run = await traced("scripts/dispatch-notifications.mjs", { SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: undefined });
  assert.equal(run.code, 0, run.out);
  assert.ok(run.loaded.includes("lib/notifications/dispatch.ts"), "the trace saw nothing");
  for (const file of run.loaded) assert.ok(shipped.has(file.split("/")[0]!), `the dispatcher loaded ${file}, which the image does not ship`);
});

test("traced: every project file the sweep actually loads ships in the image", { skip: database && process.env.BUCKET_ENDPOINT ? false : "set DATABASE_URL and BUCKET_*" }, async () => {
  const shipped = shippedPaths();
  const run = await traced("scripts/sweep-pending.mjs", {});
  assert.equal(run.code, 0, run.out);
  assert.ok(run.loaded.includes("lib/db/files.ts"), "the trace saw nothing");
  for (const file of run.loaded) assert.ok(shipped.has(file.split("/")[0]!), `the sweep loaded ${file}, which the image does not ship`);
});

/* ---------------------------------------------------------- container */

const image = process.env.RUNTIME_IMAGE;
const containerSkip = image && database ? false : "set RUNTIME_IMAGE to an image built from this Dockerfile, and DATABASE_URL";

type Run = { code: number; out: string };

/** `docker run` on the host network — the container reaches this test's database and stand-ins. */
function inImage(command: string, env: Record<string, string>): Promise<Run> {
  const flags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return new Promise((done) => {
    const child = spawn("docker", ["run", "--rm", "--network", "host", ...flags, image!, "sh", "-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    child.on("close", (code) => done({ code: code ?? -1, out }));
  });
}

let provider: Server | null = null;
let providerUrl = "";
let providerRequests = 0;

before(async () => {
  if (containerSkip) return;
  provider = createServer((request, response) => {
    providerRequests += 1;
    request.resume();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "standin" }));
  });
  await new Promise<void>((done) => provider!.listen(0, "127.0.0.1", done));
  providerUrl = `http://127.0.0.1:${(provider!.address() as { port: number }).port}`;
});

after(async () => {
  if (provider) await new Promise<void>((done) => provider!.close(() => done()));
  if (!containerSkip) {
    const { clearOwner } = await import("./support/review-stage.ts");
    const { closeDb } = await import("../lib/db/index.ts");
    await clearOwner();
    await closeDb();
  }
});

/** What a beta container is given: preview, no redirect, a key that would reach only the stand-in. */
const betaLike = () => ({
  DATABASE_URL: database!,
  SITE_ENV: "preview",
  RESEND_API_KEY: "re_test_not_a_real_key",
  RESEND_BASE_URL: providerUrl,
  RESEND_FROM_EMAIL: "notify@example.test",
  CONTACT_EMAIL: "studio-inbox@example.test",
  APP_URL: "http://localhost:3000",
  CLIENT_AUTH_URL: "http://localhost:3000",
  BETTER_AUTH_SECRET: "x".repeat(40),
  CLIENT_AUTH_SECRET: "y".repeat(40),
});

test("container: the modules are there, and the image carries no tests, docs, git or env files", { skip: containerSkip }, async () => {
  const run = await inImage(
    "test -f lib/notifications/dispatch.ts && test -f lib/db/files.ts && test -f scripts/dispatch-notifications.mjs && echo MODULES-OK; " +
      "for p in tests docs .git .env CLAUDE.md; do test -e $p && echo FOUND-$p; done; id -un",
    {},
  );
  assert.match(run.out, /MODULES-OK/);
  assert.doesNotMatch(run.out, /FOUND-/);
  assert.match(run.out, /nextjs/, "the image no longer runs as its unprivileged user");
});

test("container: env:check reports capture, and the dispatcher runs: nothing due, then real rows captured, no provider called", { skip: containerSkip }, async () => {
  const check = await inImage("npm run --silent env:check", betaLike());
  assert.equal(check.code, 0, check.out);
  assert.match(check.out, /Stage G notifications: captured, none sent \(preview\)\./);

  const { db } = await import("../lib/db/index.ts");
  const { notificationDeliveries, clientIdentity } = await import("../lib/db/schema.ts");
  const { seedOwner, stage, round } = await import("./support/review-stage.ts");
  await seedOwner();

  const idle = await inImage("npm run --silent notifications:dispatch; echo EXIT=$?", betaLike());
  assert.match(idle.out, /EXIT=0/, idle.out);
  assert.match(idle.out, /"event":"notification.dispatched".*"claimed":0/);

  const s = await stage("RI");
  await round(s); // two pending review.requested rows, written by the real domain action
  const pending = await db().select().from(notificationDeliveries);
  assert.equal(pending.length, 2);
  assert.ok(pending.every((row) => row.status === "pending"));

  providerRequests = 0;
  const run = await inImage("npm run --silent notifications:dispatch; echo EXIT=$?", betaLike());
  assert.match(run.out, /EXIT=0/, run.out);
  const summary = JSON.parse(run.out.split("\n").find((line) => line.includes("notification.dispatched"))!);
  assert.equal(summary.claimed, 2);
  assert.equal(summary.captured, 2);
  assert.equal(summary.sent, 0);
  assert.equal(providerRequests, 0, "the container called the provider in capture mode");

  const settled = await db().select().from(notificationDeliveries);
  assert.ok(settled.every((row) => row.status === "suppressed" && row.suppressedReason === "preview_capture"));
  const address = (await db().select().from(clientIdentity).where(eq(clientIdentity.id, s.ana.identityId)))[0]!.email;
  for (const leak of [address, "Brand Direction", "/workrooms/", "yw-notification/", "re_test_not_a_real_key"]) {
    assert.ok(!run.out.includes(leak), `the container's output carried ${leak}`);
  }
});

test("container: the dispatcher exits 1 only when it cannot reach a database", { skip: containerSkip }, async () => {
  const run = await inImage("npm run --silent notifications:dispatch; echo EXIT=$?", { ...betaLike(), DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" });
  assert.match(run.out, /EXIT=1/);
  assert.ok(!run.out.includes("nobody@"), "the connection string reached the log");
});

test("container: storage:sweep runs against a test bucket and completes", { skip: containerSkip || (process.env.BUCKET_ENDPOINT ? false : "set BUCKET_*") }, async () => {
  const run = await inImage("npm run --silent storage:sweep; echo EXIT=$?", {
    DATABASE_URL: database!,
    BUCKET_ENDPOINT: process.env.BUCKET_ENDPOINT!,
    BUCKET_NAME: process.env.BUCKET_NAME!,
    BUCKET_REGION: process.env.BUCKET_REGION!,
    BUCKET_ACCESS_KEY_ID: process.env.BUCKET_ACCESS_KEY_ID!,
    BUCKET_SECRET_ACCESS_KEY: process.env.BUCKET_SECRET_ACCESS_KEY!,
  });
  assert.match(run.out, /EXIT=0/, run.out);
  assert.match(run.out, /"event":"sweep.complete"/);
  assert.ok(!run.out.includes(process.env.BUCKET_SECRET_ACCESS_KEY!), "the bucket secret reached the log");
});
