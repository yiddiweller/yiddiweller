import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, afterEach, before, beforeEach, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import { claimDue } from "../lib/db/notifications.ts";
import {
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
} from "../lib/db/presentations.ts";
import { createReviewNote, removeReviewNote, requestReview, withdrawReview } from "../lib/db/reviews.ts";
import { clientIdentity, notificationDeliveries, workroomMembers } from "../lib/db/schema.ts";
import { revokeMembership, unpublishWorkroom, findWorkroom } from "../lib/db/workrooms.ts";
import { providerIdempotencyKey } from "../lib/notifications/dedupe.ts";
import { dispatchDue, IMMEDIATE_BATCH, SCHEDULED_BATCH } from "../lib/notifications/dispatch.ts";
import { drainOnce } from "../lib/notifications/drain.ts";
import { previewLine, SUBJECTS } from "../lib/notifications/render.ts";
import type { MailMessage, MailTransport, SendOutcome } from "../lib/notifications/transport.ts";
import { RecordingTransport } from "./support/recording-transport.ts";
import { clearOwner, owner, seedOwner, stage, staff, type Stage } from "./support/review-stage.ts";

/**
 * Stage G2's dispatcher, driven over rows the real Review actions wrote, in a
 * real PostgreSQL: the re-check before every send, the three modes, retries,
 * the provider key, crash recovery and two dispatchers racing. A recording
 * transport stands in for the provider in-process; the command is run as a
 * child process against a local stand-in for Resend's API. Nothing here
 * reaches the internet.
 */

const ORIGIN = "https://client.example.test";
const STUDIO = "studio.example.test";
const INBOX = "studio-inbox@example.test";
const FROM = "Yiddi Weller <notify@example.test>";
const REDIRECT = "preview-inbox@example.test";
const MINUTE = 60_000;

const ENV_KEYS = [
  "SITE_ENV",
  "NOTIFICATION_REDIRECT_TO",
  "CLIENT_AUTH_URL",
  "STUDIO_HOST",
  "APP_URL",
  "CONTACT_EMAIL",
  "RESEND_FROM_EMAIL",
  "RESEND_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};

function live(): void {
  delete process.env.SITE_ENV;
  delete process.env.NOTIFICATION_REDIRECT_TO;
  process.env.CLIENT_AUTH_URL = ORIGIN;
  process.env.STUDIO_HOST = STUDIO;
  process.env.CONTACT_EMAIL = INBOX;
  process.env.RESEND_FROM_EMAIL = FROM;
  process.env.RESEND_API_KEY = "re_test_not_a_real_key";
}

before(async () => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  await seedOwner();
});
beforeEach(async () => {
  live();
  await db().delete(notificationDeliveries);
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});
after(async () => {
  await clearOwner();
  await closeDb();
});

/* ------------------------------------------------------------- helpers */

type Delivery = typeof notificationDeliveries.$inferSelect;

const rows = (): Promise<Delivery[]> => db().select().from(notificationDeliveries);
const row = async (id: string): Promise<Delivery> =>
  (await db().select().from(notificationDeliveries).where(eq(notificationDeliveries.id, id)))[0]!;

const currentRevision = async (s: Stage) => (await findPresentation(s.presentationId))!.currentRevisionId!;

async function request(s: Stage): Promise<string> {
  const made = await requestReview(staff, await currentRevision(s));
  assert.ok(made.ok, made.ok ? "" : made.message);
  return made.value.reviewId;
}

async function publishNewer(s: Stage): Promise<void> {
  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok((await addNoteItem(owner, s.presentationId, await v(), { caption: "More", body: "More." })).ok);
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);
}

async function revoke(contactId: string): Promise<void> {
  const [member] = await db().select().from(workroomMembers).where(eq(workroomMembers.contactId, contactId));
  assert.ok((await revokeMembership(owner, member!.id, member!.version)).ok);
}

async function email(identityId: string): Promise<string> {
  return (await db().select().from(clientIdentity).where(eq(clientIdentity.id, identityId)))[0]!.email;
}

/** A transport that fails the test the moment anything is handed to it. */
const NEVER: MailTransport = {
  send: async () => {
    throw new Error("a transport was called");
  },
};

/** Every console line written while `work` runs. */
async function logged<T>(work: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ["log", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  }
  try {
    return { value: await work(), lines };
  } finally {
    Object.assign(console, original);
  }
}

const notificationLines = (lines: string[]) =>
  lines.filter((line) => line.includes('"event":"notification.')).map((line) => JSON.parse(line) as Record<string, unknown>);

/* ------------------------------------------------------------- live mode */

test("live: a request goes to each member's current sign-in address, Reply-To the studio, the exact Revision linked", async () => {
  const s = await stage("DA");
  const reviewId = await request(s);
  const transport = new RecordingTransport();

  const { value: summary, lines } = await logged(() => dispatchDue({ transport }));
  assert.deepEqual(summary, { claimed: 2, sent: 2, captured: 0, suppressed: 0, retried: 0, failed: 0 });

  const link = `${ORIGIN}/workrooms/${s.room}/presentations/${s.presentation}/revisions/2`;
  const addresses = [await email(s.ana.identityId), await email(s.ben.identityId)].sort();
  assert.deepEqual(transport.sent.map((m) => m.to).sort(), addresses);
  for (const message of transport.sent) {
    assert.equal(message.from, FROM);
    assert.equal(message.replyTo, INBOX);
    assert.equal(message.subject, SUBJECTS["review.requested"]);
    assert.ok(message.text.includes(link), "the client link is not the exact Revision");
    assert.ok(message.html.includes(link));
    assert.ok(message.text.includes("Brand Direction") && message.text.includes("Version 2"));
    assert.ok(!message.text.includes("Preview notification"), "production carries the preview line");
  }

  for (const delivery of await rows()) {
    assert.equal(delivery.presentationReviewId, reviewId);
    assert.equal(delivery.status, "sent");
    assert.equal(delivery.attempts, 1);
    assert.match(delivery.providerMessageId ?? "", /^fake-/);
    assert.ok(transport.sent.some((m) => m.idempotencyKey === providerIdempotencyKey(delivery.id)));
  }

  const logs = notificationLines(lines);
  assert.equal(logs.filter((l) => l.event === "notification.sent").length, 2);
  for (const l of logs) assert.deepEqual(Object.keys(l).sort(), ["at", "attempt", "delivery", "event", "kind", "level"]);
});

test("live: feedback goes to the studio inbox read now, no Reply-To, linking the note on its own Revision", async () => {
  const s = await stage("DB");
  const reviewId = await request(s);
  await db().delete(notificationDeliveries);
  const note = await createReviewNote(s.ana, {
    reviewId,
    body: "MARKER-G2-FEEDBACK",
    itemPosition: 1,
    anchor: { kind: "point", x: 0.123, y: 0.456 },
  });
  assert.ok(note.ok);

  process.env.CONTACT_EMAIL = "moved-inbox@example.test"; // changed after enqueue
  const transport = new RecordingTransport();
  const { lines } = await logged(() => dispatchDue({ transport }));
  assert.equal(transport.sent.length, 1);
  const [message] = transport.sent;
  assert.equal(message!.to, "moved-inbox@example.test");
  assert.equal(message!.replyTo, undefined);
  assert.equal(message!.subject, SUBJECTS["review.received"]);
  const link = `https://${STUDIO}/workrooms/${s.workroomId}/presentations/${s.presentationId}/revisions/2?note=${note.value}`;
  assert.ok(message!.text.includes(link), "the Studio link is not the exact Revision and note");
  assert.ok(message!.text.includes(s.ana.name), "the client's name is missing");

  const everything = JSON.stringify(transport.sent) + lines.join("\n");
  for (const secret of ["MARKER-G2-FEEDBACK", "0.123", "0.456", "MARKER-STORAGE-KEY", "MARKER-PREVIEW-KEY", "X-Amz", "Signature="]) {
    assert.ok(!everything.includes(secret), `${secret} reached a message or a log`);
  }
});

test("live: the address is read at dispatch time, not enqueue time", async () => {
  const s = await stage("DC");
  await request(s);
  await db().update(clientIdentity).set({ email: "dc-changed@example.test" }).where(eq(clientIdentity.id, s.ana.identityId));
  const transport = new RecordingTransport();
  await dispatchDue({ transport });
  assert.ok(transport.sent.some((m) => m.to === "dc-changed@example.test"));
  assert.ok(!transport.sent.some((m) => m.to.startsWith("dc-") && m.to.includes("marker-client-email")));
});

/* ------------------------------------------------------ access re-check */

test("access is re-checked before every send: revoked, inactive and unpublished are suppressed, not sent", async () => {
  const s = await stage("DD");
  await request(s);
  await revoke(s.ben.contactId);
  await db().update(clientIdentity).set({ status: "inactive" }).where(eq(clientIdentity.id, s.ana.identityId));
  const transport = new RecordingTransport();
  const summary = await dispatchDue({ transport });
  assert.equal(transport.sent.length, 0, "a send reached somebody who lost access");
  assert.equal(summary.suppressed, 2);
  const reasons = (await rows()).map((r) => [r.clientIdentityId, r.suppressedReason]);
  assert.deepEqual(
    Object.fromEntries(reasons),
    { [s.ana.identityId]: "recipient_inactive", [s.ben.identityId]: "membership_revoked" },
  );

  const t = await stage("DD2");
  await request(t);
  const workroom = await findWorkroom(t.workroomId);
  assert.ok((await unpublishWorkroom(owner, t.workroomId, workroom!.version)).ok);
  await dispatchDue({ transport });
  assert.equal(transport.sent.length, 0);
  assert.ok((await rows()).filter((r) => r.workroomId === t.workroomId).every((r) => r.suppressedReason === "workroom_unavailable"));
});

test("a request superseded before dispatch is suppressed; feedback on that version still goes, still linking it", async () => {
  const s = await stage("DE");
  const reviewId = await request(s);
  const note = await createReviewNote(s.ana, { reviewId, body: "On version two." });
  assert.ok(note.ok);
  await publishNewer(s); // Version 3; the round on Version 2 closes, superseded.

  const transport = new RecordingTransport();
  await dispatchDue({ transport });
  const all = await rows();
  for (const r of all.filter((r) => r.kind === "review.requested")) {
    assert.equal(r.status, "suppressed");
    assert.equal(r.suppressedReason, "superseded");
  }
  const received = all.find((r) => r.kind === "review.received")!;
  assert.equal(received.status, "sent", "feedback was suppressed because a newer version exists");
  assert.equal(transport.sent.length, 1);
  const text = transport.sent[0]!.text;
  assert.ok(text.includes(`/revisions/2?note=${note.value}`), "the link moved to the latest version");
  assert.ok(!text.includes("/revisions/3"));
  assert.ok(text.includes("Version 2"));
});

test("an old request episode never sends after the round was asked again; the new one does, once each", async () => {
  const s = await stage("DF");
  const reviewId = await request(s);
  const episodeA = (await rows()).map((r) => r.id);
  assert.ok((await withdrawReview(staff, reviewId)).ok);
  await request(s);
  const episodeB = (await rows()).map((r) => r.id).filter((id) => !episodeA.includes(id));
  assert.equal(episodeB.length, 2);

  const transport = new RecordingTransport();
  await dispatchDue({ transport });
  assert.equal(transport.sent.length, 2, "both episodes sent");
  for (const id of episodeA) {
    const r = await row(id);
    assert.equal(r.status, "suppressed");
    assert.equal(r.suppressedReason, "withdrawn");
  }
  for (const id of episodeB) assert.equal((await row(id)).status, "sent");
  assert.deepEqual(
    transport.sent.map((m) => m.idempotencyKey).sort(),
    episodeB.map((id) => providerIdempotencyKey(id)).sort(),
  );
});

test("feedback taken back before dispatch, with nothing else said, is suppressed as retracted", async () => {
  const s = await stage("DG");
  const reviewId = await request(s);
  await db().delete(notificationDeliveries);
  const note = await createReviewNote(s.ana, { reviewId, body: "Never mind." });
  assert.ok(note.ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId, number: note.value })).ok);
  const transport = new RecordingTransport();
  await dispatchDue({ transport });
  assert.equal(transport.sent.length, 0);
  const [r] = await rows();
  assert.equal(r!.suppressedReason, "retracted");
});

/* --------------------------------------------------------- preview modes */

test("preview capture: nothing is sent, nothing is configured, each row settles preview_capture with a safe line", async () => {
  process.env.SITE_ENV = "preview";
  delete process.env.RESEND_API_KEY;
  delete process.env.CONTACT_EMAIL;
  delete process.env.RESEND_FROM_EMAIL;
  const s = await stage("DH");
  const reviewId = await request(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "MARKER-CAPTURED-BODY" })).ok);
  // Access is judged before capture: a revoked member is suppressed for that.
  await revoke(s.ben.contactId);

  const { value: summary, lines } = await logged(() => dispatchDue({ transport: NEVER }));
  assert.deepEqual(summary, { claimed: 3, sent: 0, captured: 2, suppressed: 1, retried: 0, failed: 0 });
  const all = await rows();
  assert.equal(all.filter((r) => r.suppressedReason === "preview_capture").length, 2);
  assert.equal(all.find((r) => r.clientIdentityId === s.ben.identityId)!.suppressedReason, "membership_revoked");

  const captured = notificationLines(lines).filter((l) => l.event === "notification.captured");
  assert.equal(captured.length, 2);
  for (const l of captured) assert.deepEqual(Object.keys(l).sort(), ["at", "delivery", "event", "kind", "level", "role"]);
  assert.deepEqual(captured.map((l) => l.role).sort(), ["client", "studio_inbox"]);
  const text = lines.join("\n");
  for (const secret of [await email(s.ana.identityId), "MARKER-CAPTURED-BODY", "Brand Direction", "/workrooms/"]) {
    assert.ok(!text.includes(secret), `a capture line carried ${secret}`);
  }
});

test("preview capture is the default for a malformed redirect, too", async () => {
  process.env.SITE_ENV = "preview";
  process.env.NOTIFICATION_REDIRECT_TO = "two@example.test, three@example.test";
  const s = await stage("DI");
  await request(s);
  const summary = await dispatchDue({ transport: NEVER });
  assert.equal(summary.captured, 2);
});

test("preview redirect: only the test inbox receives, the intended address appears nowhere, the role line says who", async () => {
  process.env.SITE_ENV = "preview";
  process.env.NOTIFICATION_REDIRECT_TO = REDIRECT;
  const s = await stage("DJ");
  const reviewId = await request(s);
  const note = await createReviewNote(s.ana, { reviewId, body: "MARKER-REDIRECT-BODY" });
  assert.ok(note.ok);

  const transport = new RecordingTransport();
  const { lines } = await logged(() => dispatchDue({ transport }));
  assert.equal(transport.sent.length, 3);
  for (const message of transport.sent) assert.equal(message.to, REDIRECT);

  const client = transport.sent.filter((m) => m.subject === SUBJECTS["review.requested"]);
  const studio = transport.sent.filter((m) => m.subject === SUBJECTS["review.received"]);
  assert.equal(client.length, 2);
  assert.equal(studio.length, 1);
  for (const m of client) {
    assert.ok(m.text.includes(previewLine("client")) && m.html.includes(previewLine("client")));
    assert.equal(m.replyTo, INBOX, "the reply path being tested is the studio's");
    assert.ok(m.text.includes(`${ORIGIN}/workrooms/${s.room}/presentations/${s.presentation}/revisions/2`));
  }
  assert.ok(studio[0]!.text.includes(previewLine("studio_inbox")));
  assert.equal(studio[0]!.replyTo, undefined);
  assert.ok(studio[0]!.text.includes(`/revisions/2?note=${note.value}`));

  const ids = (await rows()).map((r) => r.id);
  assert.deepEqual(transport.sent.map((m) => m.idempotencyKey).sort(), ids.map(providerIdempotencyKey).sort());

  const everything = JSON.stringify(transport.sent) + lines.join("\n");
  for (const secret of [await email(s.ana.identityId), await email(s.ben.identityId), s.ana.identityId, s.ben.identityId, "MARKER-REDIRECT-BODY"]) {
    assert.ok(!everything.includes(secret), `redirect mode leaked ${secret}`);
  }
  // The studio's own message never names the studio inbox either.
  assert.ok(!JSON.stringify(studio).includes(INBOX));
});

/* ----------------------------------------------------- retry and failure */

test("a provider 5xx is retried on schedule with the same key, and a later success settles it", async () => {
  const s = await stage("DK");
  await request(s);
  await db().delete(notificationDeliveries).where(eq(notificationDeliveries.clientIdentityId, s.ben.identityId));
  const now = new Date();
  const transport = new RecordingTransport().answer({ ok: false, error: "provider_5xx" });

  const first = await dispatchDue({ transport, now: () => now });
  assert.equal(first.retried, 1);
  const [pending] = await rows();
  assert.equal(pending!.status, "pending");
  assert.equal(pending!.lastError, "provider_5xx");
  assert.equal(pending!.nextAttemptAt!.getTime(), now.getTime() + MINUTE);

  assert.equal((await dispatchDue({ transport, now: () => new Date(now.getTime() + 30_000) })).claimed, 0, "retried early");
  const second = await dispatchDue({ transport, now: () => new Date(now.getTime() + MINUTE + 1) });
  assert.equal(second.sent, 1);
  assert.equal(transport.sent.length, 2);
  assert.equal(transport.sent[0]!.idempotencyKey, transport.sent[1]!.idempotencyKey, "a retry changed the provider key");
  assert.equal(transport.sent[0]!.idempotencyKey, providerIdempotencyKey(pending!.id));
  const [sent] = await rows();
  assert.equal(sent!.status, "sent");
  assert.equal(sent!.attempts, 2);
});

test("a terminal provider answer fails at once; missing configuration fails without calling anybody", async () => {
  const s = await stage("DL");
  await request(s);
  const transport = new RecordingTransport().answer({ ok: false, error: "invalid_from_address" }, { ok: false, error: "validation_error" });
  const summary = await dispatchDue({ transport });
  assert.equal(summary.failed, 2);
  assert.deepEqual((await rows()).map((r) => r.lastError).sort(), ["invalid_from_address", "validation_error"]);

  await db().delete(notificationDeliveries);
  const t = await stage("DL2");
  await request(t);
  delete process.env.RESEND_API_KEY;
  const none = await dispatchDue({ transport: NEVER });
  assert.equal(none.failed, 2);
  assert.ok((await rows()).every((r) => r.status === "failed" && r.lastError === "invalid_api_key"));
});

test("a transport that throws is a retried unknown failure, and never stops the batch", async () => {
  const s = await stage("DM");
  await request(s);
  let calls = 0;
  const flaky: MailTransport = {
    send: async () => {
      calls += 1;
      if (calls === 1) throw new Error("MARKER-THROWN-MESSAGE");
      return { ok: true, providerMessageId: "ok" };
    },
  };
  const { value: summary, lines } = await logged(() => dispatchDue({ transport: flaky }));
  assert.equal(summary.retried, 1);
  assert.equal(summary.sent, 1);
  assert.ok((await rows()).some((r) => r.lastError === "unknown" && r.status === "pending"));
  assert.ok(!lines.join("\n").includes("MARKER-THROWN-MESSAGE"));
});

/* ---------------------------------------------- concurrency and crashes */

test("two dispatchers racing hand each delivery to the transport exactly once", async () => {
  for (const tag of ["DN1", "DN2", "DN3", "DN4"]) {
    const s = await stage(tag);
    const reviewId = await request(s);
    assert.ok((await createReviewNote(s.ana, { reviewId, body: "Hello." })).ok);
  }
  const total = (await rows()).length;
  assert.equal(total, 12);

  const transport = new RecordingTransport();
  const slow: MailTransport = {
    send: async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return transport.send(message);
    },
  };
  const [one, two] = await Promise.all([dispatchDue({ transport: slow, limit: 8 }), dispatchDue({ transport: slow, limit: 8 })]);
  const third = await dispatchDue({ transport: slow });
  assert.equal(one.claimed + two.claimed + third.claimed, total);
  assert.equal(transport.sent.length, total);
  assert.equal(new Set(transport.sent.map((m) => m.idempotencyKey)).size, total, "a delivery was sent twice");
  assert.ok((await rows()).every((r) => r.status === "sent" && r.attempts === 1));
});

test("provider accepted, process died before settling: the reclaimed retry uses the same key, and the dead claim cannot settle", async () => {
  const s = await stage("DO");
  await request(s);
  await db().delete(notificationDeliveries).where(eq(notificationDeliveries.clientIdentityId, s.ben.identityId));
  const [only] = await rows();

  let accept!: (outcome: SendOutcome) => void;
  const first: MailMessage[] = [];
  const dying: MailTransport = {
    send: (message) => {
      first.push(message);
      return new Promise<SendOutcome>((resolve) => (accept = resolve));
    },
  };
  const start = new Date();
  const abandoned = dispatchDue({ transport: dying, now: () => start });
  while (first.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await row(only!.id)).status, "sending");

  // Eleven minutes later another dispatcher finds the abandoned claim.
  const later = new Date(start.getTime() + 11 * MINUTE);
  const transport = new RecordingTransport();
  const recovered = await dispatchDue({ transport, now: () => later });
  assert.equal(recovered.sent, 1);
  assert.equal(transport.sent[0]!.idempotencyKey, first[0]!.idempotencyKey, "the retry was a different request to the provider");

  // The dead dispatcher wakes and tries to settle its old claim: refused.
  accept({ ok: true, providerMessageId: "from-the-dead" });
  await abandoned;
  const settled = await row(only!.id);
  assert.equal(settled.status, "sent");
  assert.equal(settled.attempts, 2);
  assert.notEqual(settled.providerMessageId, "from-the-dead", "an abandoned claim overwrote the newer attempt");
});

test("the batch is bounded, and the drain is smaller still and never rejects", async () => {
  assert.equal(SCHEDULED_BATCH, 25);
  assert.equal(IMMEDIATE_BATCH, 5);
  for (const tag of ["DP1", "DP2", "DP3", "DP4"]) await request(await stage(tag));
  process.env.SITE_ENV = "preview";
  const first = await dispatchDue({ transport: NEVER, limit: 100 });
  assert.equal(first.claimed, 8);
  for (const tag of ["DP5", "DP6", "DP7"]) await request(await stage(tag));
  await drainOnce(); // capture mode, so no provider is reachable from here
  const left = (await rows()).filter((r) => r.status === "pending").length;
  assert.equal(left, 1, "the drain took more than its batch");

  // A drain over an unreachable database answers nothing and throws nothing.
  const url = process.env.DATABASE_URL;
  await closeDb();
  process.env.DATABASE_URL = "postgres://nobody@127.0.0.1:1/none";
  try {
    const { lines } = await logged(() => drainOnce());
    assert.deepEqual(notificationLines(lines).map((l) => l.event), ["notification.drain_failed"]);
    assert.deepEqual(Object.keys(notificationLines(lines)[0]!).sort(), ["at", "event", "level"]);
  } finally {
    await closeDb();
    process.env.DATABASE_URL = url;
  }
});

test("HTML in a title is escaped, and the subject is fixed", async () => {
  const s = await stage("DQ");
  const made = await createPresentation(owner, s.workroomId, { title: '<img src=x onerror="alert(1)">\r\nBcc: evil@example.test', intro: "" });
  assert.ok(made.ok);
  const v = async () => (await findPresentation(made.value))!.version;
  assert.ok((await addNoteItem(owner, made.value, await v(), { caption: "One", body: "Words." })).ok);
  assert.ok((await publishPresentation(owner, made.value, await v())).ok);
  assert.ok((await requestReview(staff, (await findPresentation(made.value))!.currentRevisionId!)).ok);

  const transport = new RecordingTransport();
  await dispatchDue({ transport });
  const message = transport.sent.find((m) => m.text.includes("Bcc"))!;
  assert.ok(message, "the titled message was not sent");
  // The template's own footer mark is an <img>; the title's must never be.
  assert.ok(!message.html.includes("<img src=x"), "markup in a title reached the HTML");
  assert.ok(!message.html.includes('onerror="alert'));
  assert.ok(message.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.equal(message.subject, SUBJECTS["review.requested"]);
  assert.ok(!/[\r\n]/.test(message.subject));
});

/* ------------------------------------------------------------- the command */

type Captured = { headers: IncomingHttpHeaders; body: Record<string, unknown> };

/** A stand-in for Resend's API that records every request and answers from a script. */
async function standIn(script: number[]): Promise<{ url: string; requests: Captured[]; server: Server }> {
  const requests: Captured[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      const status = script.shift() ?? 200;
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        status === 200
          ? JSON.stringify({ id: `standin-${requests.length}` })
          : JSON.stringify({ name: "internal_server_error", message: "MARKER-PROVIDER-WORDS", statusCode: status }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, requests, server };
}

function command(env: Record<string, string | undefined>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "--silent", "notifications:dispatch"], {
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += String(chunk)));
    child.stderr.on("data", (chunk) => (out += String(chunk)));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
  });
}

test("the process that wrote the rows died: the command, run later, captures them on the preview", async () => {
  const s = await stage("DR");
  await request(s); // no hook: nothing drains, as if the process stopped at commit
  assert.ok((await rows()).every((r) => r.status === "pending"));

  const run = await command({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: undefined, RESEND_API_KEY: undefined });
  assert.equal(run.code, 0, run.out);
  assert.ok((await rows()).every((r) => r.status === "suppressed" && r.suppressedReason === "preview_capture"));
  const summary = run.out.split("\n").find((line) => line.includes("notification.dispatched"));
  assert.ok(summary, run.out);
  assert.equal(JSON.parse(summary!).captured, 2);
  assert.ok(!run.out.includes(await email(s.ana.identityId)));

  const again = await command({ SITE_ENV: "preview" });
  assert.equal(again.code, 0);
  assert.equal(JSON.parse(again.out.split("\n").find((line) => line.includes("notification.dispatched"))!).claimed, 0);
});

test("the command, live, sends through the real Resend adapter with the row's key — and the retry reuses it", async () => {
  const s = await stage("DS");
  await request(s);
  await db().delete(notificationDeliveries).where(eq(notificationDeliveries.clientIdentityId, s.ben.identityId));
  const [only] = await rows();
  const provider = await standIn([500]);
  try {
    const env = { SITE_ENV: undefined, RESEND_BASE_URL: provider.url, RESEND_API_KEY: "re_test_not_a_real_key", CONTACT_EMAIL: INBOX, RESEND_FROM_EMAIL: FROM, CLIENT_AUTH_URL: ORIGIN, STUDIO_HOST: STUDIO };
    const first = await command(env);
    assert.equal(first.code, 0, "a retried row failed the command");
    assert.equal((await row(only!.id)).lastError, "provider_5xx");
    assert.ok(!first.out.includes("MARKER-PROVIDER-WORDS"), "the provider's words reached the log");

    await db().update(notificationDeliveries).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(notificationDeliveries.id, only!.id));
    const second = await command(env);
    assert.equal(second.code, 0);
    assert.equal((await row(only!.id)).status, "sent");

    assert.equal(provider.requests.length, 2);
    const keys = provider.requests.map((r) => r.headers["idempotency-key"]);
    assert.equal(keys[0], providerIdempotencyKey(only!.id));
    assert.equal(keys[1], keys[0], "the retry was sent with a different key");
    assert.deepEqual([provider.requests[0]!.body.to].flat(), [await email(s.ana.identityId)]);
    assert.deepEqual([provider.requests[0]!.body.reply_to].flat(), [INBOX]);
    for (const line of (first.out + second.out).split("\n")) assert.ok(!line.includes("@"), `an address reached the log: ${line}`);
  } finally {
    provider.server.close();
  }
});

test("the command exits 0 when nothing is due and 1 only when it cannot reach its database", async () => {
  assert.equal((await rows()).length, 0);
  const idle = await command({});
  assert.equal(idle.code, 0, idle.out);

  const unreachable = await command({ DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" });
  assert.equal(unreachable.code, 1);
  assert.ok(!unreachable.out.includes("nobody@"), "the connection string reached the log");

  const unconfigured = await command({ DATABASE_URL: "" });
  assert.equal(unconfigured.code, 1);
});

test("a claimed row is never claimed again while its claim is fresh", async () => {
  const s = await stage("DT");
  await request(s);
  const claimed = await claimDue({ limit: 10 });
  assert.equal(claimed.length, 2);
  const summary = await dispatchDue({ transport: NEVER });
  assert.equal(summary.claimed, 0);
  await db().execute(sql`UPDATE notification_deliveries SET status = 'pending', claimed_at = NULL`);
});
