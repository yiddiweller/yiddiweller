import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

import { providerIdempotencyKey } from "../lib/notifications/dedupe.ts";
import { resendTransport } from "../lib/notifications/resend-transport.ts";
import type { MailMessage } from "../lib/notifications/transport.ts";
import { RecordingTransport } from "./support/recording-transport.ts";

/**
 * Stage G1: the one way a notification will leave — `MailTransport` — with its
 * recording fake and its Resend adapter. The adapter is driven against a
 * local stand-in for Resend's API, never the real one: every request it makes
 * is caught here, and every answer is the one a test chose.
 */

type Seen = { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> };

const seen: Seen[] = [];
let reply: { status: number; body: string; contentType?: string } = { status: 200, body: '{"id":"re_123"}' };
let server: Server;
let baseUrl = "";

before(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      response.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" }).end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const DELIVERY = "01a0ef10-0000-7000-8000-0000000000d4";

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  to: "ana@example.test",
  from: "Yiddi Weller <studio@example.test>",
  replyTo: "owner@example.test",
  subject: "Your thoughts are requested — Yiddi Weller",
  html: "<p>Hello</p>",
  text: "Hello",
  idempotencyKey: providerIdempotencyKey(DELIVERY),
  ...overrides,
});

/* ---------------------------------------------------------- the fake */

test("the recording fake keeps exactly what it was handed, and answers as scripted", async () => {
  const fake = new RecordingTransport().answer({ ok: false, error: "provider_5xx" });
  assert.deepEqual(await fake.send(message()), { ok: false, error: "provider_5xx" });
  assert.deepEqual(await fake.send(message({ to: "ben@example.test" })), { ok: true, providerMessageId: "fake-2" });
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.sent[0]!.to, "ana@example.test");
  assert.equal(fake.sent[0]!.replyTo, "owner@example.test");
  assert.equal(fake.sent[0]!.idempotencyKey, `yw-notification/${DELIVERY}`);
  assert.equal(fake.sent[1]!.to, "ben@example.test");
});

/* ---------------------------------------------------------- Resend */

test("the Resend adapter sends the payload as given, with its Idempotency-Key and Reply-To", async () => {
  seen.length = 0;
  reply = { status: 200, body: '{"id":"re_abc123"}' };
  const outcome = await resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl }).send(message());
  assert.deepEqual(outcome, { ok: true, providerMessageId: "re_abc123" });

  assert.equal(seen.length, 1);
  const request = seen[0]!;
  assert.equal(request.path, "/emails");
  assert.equal(request.headers["idempotency-key"], `yw-notification/${DELIVERY}`);
  assert.equal(request.headers.authorization, "Bearer re_test_not_a_real_key");
  assert.equal(request.body.from, "Yiddi Weller <studio@example.test>");
  assert.deepEqual([].concat(request.body.to as never), ["ana@example.test"]);
  assert.equal(request.body.reply_to ?? request.body.replyTo, "owner@example.test");
  assert.equal(request.body.subject, "Your thoughts are requested — Yiddi Weller");
  assert.equal(request.body.html, "<p>Hello</p>");
  assert.equal(request.body.text, "Hello");
});

test("a retry of the same delivery is the same Idempotency-Key; another delivery is another", async () => {
  seen.length = 0;
  reply = { status: 200, body: '{"id":"re_1"}' };
  const transport = resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl });
  await transport.send(message());
  await transport.send(message());
  await transport.send(message({ idempotencyKey: providerIdempotencyKey("01a0ef10-0000-7000-8000-0000000000d5") }));
  assert.deepEqual(
    seen.map((s) => s.headers["idempotency-key"]),
    [`yw-notification/${DELIVERY}`, `yw-notification/${DELIVERY}`, "yw-notification/01a0ef10-0000-7000-8000-0000000000d5"],
  );
});

test("no Reply-To is sent when the message has none", async () => {
  seen.length = 0;
  reply = { status: 200, body: '{"id":"re_2"}' };
  await resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl }).send(message({ replyTo: undefined }));
  assert.equal(seen[0]!.body.reply_to ?? seen[0]!.body.replyTo, undefined);
});

test("failures come back as a class, and the provider's words never come back at all", async () => {
  const transport = resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl });
  const cases: Array<[typeof reply, string]> = [
    [{ status: 429, body: '{"name":"rate_limit_exceeded","statusCode":429,"message":"Too many requests for ana@example.test"}' }, "rate_limited"],
    [{ status: 422, body: '{"name":"validation_error","statusCode":422,"message":"Invalid `to` field: ana@example.test"}' }, "validation_error"],
    [{ status: 403, body: '{"name":"invalid_from_address","statusCode":403,"message":"studio@example.test is not verified"}' }, "invalid_from_address"],
    [{ status: 401, body: '{"name":"restricted_api_key","statusCode":401,"message":"restricted"}' }, "restricted_api_key"],
    [{ status: 409, body: '{"name":"concurrent_idempotent_requests","statusCode":409,"message":"in flight"}' }, "concurrent_idempotent_requests"],
    [{ status: 503, body: "<html>upstream down for ana@example.test</html>", contentType: "text/html" }, "provider_5xx"],
  ];
  for (const [answer, expected] of cases) {
    reply = answer;
    const outcome = await transport.send(message());
    assert.deepEqual(outcome, { ok: false, error: expected }, answer.body);
    assert.doesNotMatch(JSON.stringify(outcome), /ana@|studio@|Too many|Invalid|upstream|restricted"/);
  }
});

test("the adapter never writes a provider's words to the console, in any environment", async () => {
  const written: string[] = [];
  const original = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...args: unknown[]) => void written.push(args.map(String).join(" "));
  try {
    const transport = resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl });
    reply = { status: 422, body: '{"name":"validation_error","statusCode":422,"message":"Invalid to: ana@example.test"}' };
    await transport.send(message());
    reply = { status: 503, body: "<html>down</html>", contentType: "text/html" };
    await transport.send(message());
    await resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl: "http://127.0.0.1:9" }).send(message());
  } finally {
    Object.assign(console, original);
  }
  assert.deepEqual(written, [], "the provider's error reached the console");
});

test("an unreachable provider is a network failure, not a crash", async () => {
  const outcome = await resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl: "http://127.0.0.1:9" }).send(message());
  assert.deepEqual(outcome, { ok: false, error: "network" });
});

test("a malformed success keeps no provider id rather than an arbitrary one", async () => {
  reply = { status: 200, body: JSON.stringify({ id: "x".repeat(500) }) };
  assert.deepEqual(await resendTransport({ apiKey: "re_test_not_a_real_key", baseUrl }).send(message()), {
    ok: true,
    providerMessageId: null,
  });
});

test("only the dispatcher constructs the Resend transport — there is no second sender", () => {
  const callers = ["app", "lib", "components", "middleware.ts", "scripts"]
    .flatMap((root) => listSources(root))
    .filter((file) => file !== "lib/notifications/resend-transport.ts")
    .filter((file) => /resendTransport|resend-transport/.test(code(file)));
  assert.deepEqual(callers, ["lib/notifications/dispatch.ts"], "something besides the dispatcher reaches the notification transport");
});

/** A file's code, without its comments — what it does, not what it says. */
const code = (file: string) =>
  readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function listSources(root: string): string[] {
  if (statSync(root).isFile()) return [root];
  return readdirSync(root).flatMap((name: string) => {
    const path = `${root}/${name}`;
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? listSources(path) : /\.(ts|tsx|mjs|js)$/.test(name) ? [path] : [];
  });
}
