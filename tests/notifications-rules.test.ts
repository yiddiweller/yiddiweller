import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { providerIdempotencyKey, receivedDedupeKey, requestedDedupeKey } from "../lib/notifications/dedupe.ts";
import { notificationLogFields } from "../lib/notifications/log.ts";
import { notificationMode, redirectProblem } from "../lib/notifications/mode.ts";
import { isSelf, receivedIntents, requestedIntents, withoutSelf } from "../lib/notifications/recipients.ts";
import {
  ABANDONED_CLAIM_MS,
  afterFailure,
  classifyProviderError,
  decideReceived,
  decideRequested,
  MAX_ATTEMPTS,
  PROVIDER_IDEMPOTENCY_WINDOW_MS,
  RETRY_DELAYS_MS,
  RETRY_HORIZON_MS,
  type RequestedFacts,
} from "../lib/notifications/rules.ts";
import {
  DELIVERY_ERRORS,
  KIND_RECIPIENT,
  NOTIFICATION_KINDS,
  SUPPRESSION_REASONS,
  TERMINAL_ERRORS,
} from "../lib/notifications/vocabulary.ts";

/**
 * Stage G1: the notification rules as data — dedupe and provider keys,
 * recipients and the self rule, suppression, retries, error classes, preview
 * mode and the log whitelist. Pure; nothing here touches a database or a
 * provider. The database half is `notifications-db.test.ts`.
 */

const REVIEW = "01a0ef10-0000-7000-8000-000000000001";
const OTHER_REVIEW = "01a0ef10-0000-7000-8000-000000000002";
const ANA = "01a0ef10-0000-7000-8000-0000000000a1";
const BEN = "01a0ef10-0000-7000-8000-0000000000b2";
const ROOM = "01a0ef10-0000-7000-8000-0000000000c3";
const DELIVERY = "01a0ef10-0000-7000-8000-0000000000d4";
const EPISODE = new Date("2026-10-06T14:00:00.123Z");

/* ------------------------------------------------------------ vocabulary */

test("V1 has two kinds and two recipients, and no reply, resolution or close among them", () => {
  assert.deepEqual([...NOTIFICATION_KINDS], ["review.requested", "review.received"]);
  assert.deepEqual(KIND_RECIPIENT, { "review.requested": "client", "review.received": "studio_inbox" });
  for (const word of ["reply", "replied", "resolved", "reopened", "closed", "withdrawn", "superseded", "published", "shared"]) {
    assert.ok(!NOTIFICATION_KINDS.some((kind) => kind.includes(word)), word);
  }
  for (const terminal of TERMINAL_ERRORS) assert.ok(DELIVERY_ERRORS.includes(terminal));
});

/* ------------------------------------------------------------ dedupe keys */

test("the same request episode to the same client is one key; a new episode or a second client is another", () => {
  const key = requestedDedupeKey({ reviewId: REVIEW, requestedAt: EPISODE, clientIdentityId: ANA });
  assert.equal(key, requestedDedupeKey({ reviewId: REVIEW, requestedAt: new Date(EPISODE.getTime()), clientIdentityId: ANA }));
  // Asked again after a withdrawal: a new episode, a new key.
  assert.notEqual(key, requestedDedupeKey({ reviewId: REVIEW, requestedAt: new Date(EPISODE.getTime() + 1), clientIdentityId: ANA }));
  // Two clients, two keys.
  assert.notEqual(key, requestedDedupeKey({ reviewId: REVIEW, requestedAt: EPISODE, clientIdentityId: BEN }));
  // Another round, another key.
  assert.notEqual(key, requestedDedupeKey({ reviewId: OTHER_REVIEW, requestedAt: EPISODE, clientIdentityId: ANA }));
  assert.ok(key.length <= 200);
});

test("a round's feedback is one key, whatever is said after it", () => {
  assert.equal(receivedDedupeKey({ reviewId: REVIEW }), receivedDedupeKey({ reviewId: REVIEW.toUpperCase() }));
  assert.notEqual(receivedDedupeKey({ reviewId: REVIEW }), receivedDedupeKey({ reviewId: OTHER_REVIEW }));
  assert.notEqual(
    receivedDedupeKey({ reviewId: REVIEW }),
    requestedDedupeKey({ reviewId: REVIEW, requestedAt: EPISODE, clientIdentityId: ANA }),
  );
});

test("keys are built from identifiers and moments only, and refuse anything else", () => {
  for (const bad of ["ana@example.com", "Brand Direction", "", "../x", "01a0ef10"]) {
    assert.throws(() => requestedDedupeKey({ reviewId: bad, requestedAt: EPISODE, clientIdentityId: ANA }), bad);
    assert.throws(() => requestedDedupeKey({ reviewId: REVIEW, requestedAt: EPISODE, clientIdentityId: bad }), bad);
    assert.throws(() => receivedDedupeKey({ reviewId: bad }), bad);
    assert.throws(() => providerIdempotencyKey(bad), bad);
  }
  assert.throws(() => requestedDedupeKey({ reviewId: REVIEW, requestedAt: new Date(NaN), clientIdentityId: ANA }));
  // The functions take no text at all — the signatures say so, and so does the source.
  const source = readFileSync("lib/notifications/dedupe.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /email|title|name:|body|label/i);
});

test("the provider key is the delivery's own id: one row, one key, every retry; two rows, two keys", () => {
  assert.equal(providerIdempotencyKey(DELIVERY), `yw-notification/${DELIVERY}`);
  assert.equal(providerIdempotencyKey(DELIVERY), providerIdempotencyKey(DELIVERY));
  assert.notEqual(providerIdempotencyKey(DELIVERY), providerIdempotencyKey(ANA));
  assert.doesNotMatch(providerIdempotencyKey(DELIVERY), /@|\s|http/);
});

/* -------------------------------------------------------- recipients */

test("a request reaches every eligible client once, and never the person who asked", () => {
  const studio = { side: "studio" as const, userId: "staff-1" };
  const intents = requestedIntents({
    workroomId: ROOM,
    reviewId: REVIEW,
    requestedAt: EPISODE,
    eligibleClientIdentityIds: [ANA, BEN, ANA],
    actor: studio,
  });
  assert.deepEqual(intents.map((i) => i.clientIdentityId), [ANA, BEN]);
  for (const intent of intents) {
    assert.equal(intent.kind, "review.requested");
    assert.equal(intent.recipientKind, "client");
    assert.equal(intent.noteNumber, null);
    assert.equal(intent.requestedAt, EPISODE);
    assert.deepEqual(
      Object.keys(intent).sort(),
      ["clientIdentityId", "dedupeKey", "kind", "noteNumber", "presentationReviewId", "recipientKind", "requestedAt", "workroomId"],
      "an intent carries something more than intent",
    );
  }
  assert.notEqual(intents[0]!.dedupeKey, intents[1]!.dedupeKey);

  // Were a client ever the actor, they would not hear about it.
  const self = requestedIntents({
    workroomId: ROOM,
    reviewId: REVIEW,
    requestedAt: EPISODE,
    eligibleClientIdentityIds: [ANA, BEN],
    actor: { side: "client", identityId: ANA },
  });
  assert.deepEqual(self.map((i) => i.clientIdentityId), [BEN]);
});

test("feedback reaches the studio inbox once, and no client", () => {
  const intents = receivedIntents({ workroomId: ROOM, reviewId: REVIEW, noteNumber: 1, actor: { side: "client", identityId: ANA } });
  assert.equal(intents.length, 1);
  assert.equal(intents[0]!.recipientKind, "studio_inbox");
  assert.equal(intents[0]!.clientIdentityId, null);
  assert.equal(intents[0]!.noteNumber, 1);
  assert.equal(intents[0]!.dedupeKey, receivedDedupeKey({ reviewId: REVIEW }));
});

test("no self-notification: the rule is the recipients', not the interface's", () => {
  const ana = { kind: "client" as const, clientIdentityId: ANA };
  assert.equal(isSelf(ana, { side: "client", identityId: ANA }), true);
  assert.equal(isSelf(ana, { side: "client", identityId: BEN }), false);
  assert.equal(isSelf(ana, { side: "studio", userId: ANA }), false, "a staff id is never a client");
  assert.equal(isSelf({ kind: "studio_inbox" }, { side: "studio", userId: "x" }), false, "the inbox is nobody");
  assert.deepEqual(withoutSelf([ana, { kind: "studio_inbox" }], { side: "client", identityId: ANA }), [{ kind: "studio_inbox" }]);
});

/* -------------------------------------------------------- suppression */

const standing: RequestedFacts = {
  identityActive: true,
  membershipActive: true,
  workroomAvailable: true,
  presentationAvailable: true,
  reviewStatus: "open",
  closedReason: null,
  revisionIsCurrent: true,
  episodeIsCurrent: true,
};

test("a request that still stands is sent; one that does not is suppressed, and says why", () => {
  assert.deepEqual(decideRequested(standing), { send: true });
  const cases: Array<[Partial<RequestedFacts>, string]> = [
    [{ identityActive: false }, "recipient_inactive"],
    [{ membershipActive: false }, "membership_revoked"],
    [{ workroomAvailable: false }, "workroom_unavailable"],
    [{ presentationAvailable: false }, "presentation_unavailable"],
    [{ reviewStatus: "withdrawn" }, "withdrawn"],
    [{ episodeIsCurrent: false }, "withdrawn"], // asked again since: the old episode never sends
    [{ reviewStatus: "closed", closedReason: "staff" }, "closed"],
    [{ reviewStatus: "closed", closedReason: "superseded", revisionIsCurrent: false }, "superseded"],
    [{ revisionIsCurrent: false }, "superseded"],
  ];
  for (const [change, reason] of cases) {
    assert.deepEqual(decideRequested({ ...standing, ...change }), { send: false, reason }, JSON.stringify(change));
  }
  // The person comes first: whose access ended is the most useful fact.
  assert.deepEqual(
    decideRequested({ ...standing, membershipActive: false, reviewStatus: "withdrawn" }),
    { send: false, reason: "membership_revoked" },
  );
});

test("feedback is announced unless it was taken back and nothing else remains — supersession does not stop it", () => {
  assert.deepEqual(decideReceived({ triggeringNoteLive: true, liveRootNotes: 1 }), { send: true });
  assert.deepEqual(decideReceived({ triggeringNoteLive: false, liveRootNotes: 2 }), { send: true });
  assert.deepEqual(decideReceived({ triggeringNoteLive: null, liveRootNotes: 1 }), { send: true });
  assert.deepEqual(decideReceived({ triggeringNoteLive: false, liveRootNotes: 0 }), { send: false, reason: "retracted" });
  assert.deepEqual(decideReceived({ triggeringNoteLive: null, liveRootNotes: 0 }), { send: false, reason: "retracted" });
});

test("every suppression a rule can give is in the vocabulary", () => {
  const given = new Set<string>();
  for (const change of [{ identityActive: false }, { membershipActive: false }, { workroomAvailable: false }, { presentationAvailable: false }, { reviewStatus: "withdrawn" as const }, { reviewStatus: "closed" as const }, { revisionIsCurrent: false }]) {
    const decision = decideRequested({ ...standing, ...change });
    if (!decision.send) given.add(decision.reason);
  }
  const received = decideReceived({ triggeringNoteLive: false, liveRootNotes: 0 });
  if (!received.send) given.add(received.reason);
  for (const reason of given) assert.ok(SUPPRESSION_REASONS.includes(reason as never), reason);
});

/* ------------------------------------------------------------- retries */

test("the retry schedule: 1m, 5m, 30m, 2h, 6h, then failed — inside the provider's idempotency window", () => {
  const MIN = 60_000;
  assert.deepEqual([...RETRY_DELAYS_MS], [1 * MIN, 5 * MIN, 30 * MIN, 120 * MIN, 360 * MIN]);
  assert.equal(MAX_ATTEMPTS, 6);
  assert.equal(RETRY_HORIZON_MS, 516 * MIN);
  assert.ok(RETRY_HORIZON_MS < PROVIDER_IDEMPOTENCY_WINDOW_MS / 2, "the horizon is not comfortably inside 24 hours");
  assert.equal(ABANDONED_CLAIM_MS, 10 * MIN);

  const now = new Date("2026-10-06T12:00:00Z");
  for (let attempt = 1; attempt <= 5; attempt++) {
    const next = afterFailure(attempt, "provider_5xx", now);
    assert.ok("retryAt" in next, `attempt ${attempt}`);
    assert.equal(next.retryAt.getTime() - now.getTime(), RETRY_DELAYS_MS[attempt - 1]);
  }
  assert.deepEqual(afterFailure(6, "provider_5xx", now), { fail: true });
  assert.deepEqual(afterFailure(7, "network", now), { fail: true });
  assert.deepEqual(afterFailure(0, "network", now), { fail: true });
});

test("a terminal error fails at once; a transient one waits its turn", () => {
  const now = new Date();
  for (const error of TERMINAL_ERRORS) assert.deepEqual(afterFailure(1, error, now), { fail: true }, error);
  for (const error of ["network", "rate_limited", "provider_5xx", "concurrent_idempotent_requests", "unknown"] as const) {
    assert.ok("retryAt" in afterFailure(1, error, now), error);
  }
});

test("a provider failure becomes a class, read from its name and status only", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ name: "application_error", statusCode: null, message: "Unable to fetch data." }, "network"],
    [{ name: "rate_limit_exceeded", statusCode: 429 }, "rate_limited"],
    [{ statusCode: 429 }, "rate_limited"],
    [{ name: "application_error", statusCode: 502 }, "provider_5xx"],
    [{ name: "internal_server_error", statusCode: 500 }, "provider_5xx"],
    [{ name: "concurrent_idempotent_requests", statusCode: 409 }, "concurrent_idempotent_requests"],
    [{ name: "validation_error", statusCode: 422, message: "to: ana@example.com is invalid" }, "validation_error"],
    [{ name: "invalid_idempotent_request", statusCode: 409 }, "validation_error"],
    [{ name: "invalid_from_address", statusCode: 422 }, "invalid_from_address"],
    [{ name: "invalid_api_key", statusCode: 403 }, "invalid_api_key"],
    [{ name: "missing_api_key", statusCode: 401 }, "invalid_api_key"],
    [{ name: "restricted_api_key", statusCode: 401 }, "restricted_api_key"],
    [{ name: "daily_quota_exceeded", statusCode: 429 }, "quota"],
    [{ name: "monthly_quota_exceeded", statusCode: 429 }, "quota"],
    [{ name: "something_new", statusCode: 418 }, "unknown"],
    [{}, "unknown"],
  ];
  for (const [error, expected] of cases) {
    const got = classifyProviderError(error);
    assert.equal(got, expected, JSON.stringify(error));
    assert.ok(DELIVERY_ERRORS.includes(got));
  }
});

/* ---------------------------------------------------------- preview mode */

test("production is live and never redirected; the preview captures unless a valid redirect is set", () => {
  assert.deepEqual(notificationMode({}), { mode: "live" });
  assert.deepEqual(notificationMode({ SITE_ENV: "production" }), { mode: "live" });
  assert.deepEqual(notificationMode({ NOTIFICATION_REDIRECT_TO: "me@example.com" }), { mode: "live" }, "production honoured a redirect");
  assert.deepEqual(notificationMode({ SITE_ENV: "Preview", NOTIFICATION_REDIRECT_TO: "me@example.com" }), { mode: "live" });

  assert.deepEqual(notificationMode({ SITE_ENV: "preview" }), { mode: "capture" }, "the preview defaults to sending");
  assert.deepEqual(notificationMode({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: "" }), { mode: "capture" });
  assert.deepEqual(notificationMode({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: " me@example.com " }), {
    mode: "redirect",
    to: "me@example.com",
  });
  for (const malformed of ["me", "me@", "a@b", "a b@example.com", "me@example.com,them@example.com", "x".repeat(250) + "@example.com"]) {
    assert.deepEqual(notificationMode({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: malformed }), { mode: "capture" }, malformed);
  }
});

test("the redirect's configuration problems are named, never quoted", () => {
  assert.equal(redirectProblem({}), null);
  assert.equal(redirectProblem({ NOTIFICATION_REDIRECT_TO: "me@example.com" }), "outside_preview");
  assert.equal(redirectProblem({ NOTIFICATION_REDIRECT_TO: "" }), "outside_preview", "blank is still present");
  assert.equal(redirectProblem({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: "nope" }), "malformed");
  assert.equal(redirectProblem({ SITE_ENV: "preview", NOTIFICATION_REDIRECT_TO: "me@example.com" }), null);
});

/* ------------------------------------------------------------- the log */

test("a notification log line carries only its whitelisted words", () => {
  assert.deepEqual(notificationLogFields("notification.created", { kind: "review.requested", count: 2 }), {
    kind: "review.requested",
    count: 2,
  });
  assert.deepEqual(
    notificationLogFields("notification.failed", { kind: "review.received", delivery: DELIVERY, attempt: 3, error: "network" }),
    { kind: "review.received", delivery: DELIVERY, attempt: 3, error: "network" },
  );
  assert.deepEqual(
    Object.keys(notificationLogFields("notification.captured", { kind: "review.requested", delivery: DELIVERY, role: "client" })).sort(),
    ["delivery", "kind", "role"],
  );

  const smuggled: Array<[string, Record<string, unknown>]> = [
    ["notification.sent", { kind: "review.requested", delivery: DELIVERY, attempt: 1, to: "ana@example.com" }],
    ["notification.sent", { kind: "review.requested", delivery: DELIVERY, attempt: 1, title: "Brand Direction" }],
    ["notification.sent", { kind: "review.requested", delivery: DELIVERY, attempt: 1, url: "https://x" }],
    ["notification.sent", { kind: "review.requested", delivery: DELIVERY, attempt: 1, idempotencyKey: providerIdempotencyKey(DELIVERY) }],
    ["notification.failed", { kind: "review.requested", delivery: DELIVERY, attempt: 1, error: "422: to ana@example.com is invalid" }],
    ["notification.suppressed", { kind: "review.requested", delivery: DELIVERY, reason: "because I said so" }],
    ["notification.sent", { kind: "review.replied", delivery: DELIVERY, attempt: 1 }],
    ["notification.sent", { kind: "review.requested", delivery: "ana@example.com", attempt: 1 }],
    ["notification.captured", { kind: "review.requested", delivery: DELIVERY, role: "ana@example.com" }],
  ];
  for (const [event, fields] of smuggled) {
    assert.throws(() => notificationLogFields(event as never, fields as never), JSON.stringify(fields));
  }
});
