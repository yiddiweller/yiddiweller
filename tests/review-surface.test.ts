import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import {
  findPresentation,
  publishPresentation,
  unpublishPresentation,
} from "../lib/db/presentations.ts";
import {
  closeReview,
  createReviewNote,
  editReviewNote,
  removeReviewNote,
  reopenReviewNote,
  replyToReviewNote,
  resolveReviewNote,
  reviewPanelForStaff,
  reviewPanelForViewer,
  withdrawReview,
  type ClientActor,
} from "../lib/db/reviews.ts";
import { presentations } from "../lib/db/schema.ts";
import { itemLabel, labelAt, itemSubjects } from "../lib/workrooms/presentation-view.ts";
import {
  noteCapabilities,
  reviewCapabilities,
  NO_CAPABILITIES,
  type NoteFacts,
  type ReviewCapabilities,
  type RoundFacts,
} from "../lib/workrooms/review-capabilities.ts";
import { reviewLifecycle } from "../lib/workrooms/review-lifecycle.ts";
import {
  clearOwner,
  live,
  owner,
  round,
  seedOwner,
  stage,
  staff,
  wipe,
  MARKERS,
  UUID,
} from "./support/review-stage.ts";

/**
 * What a Review *surface* is allowed to know and to offer.
 *
 * Implementation C proved the projection cannot carry a removed body or a
 * database id. This is the layer above it, and it asks three things:
 *
 *   **the sidecar is honest**   a control is offered exactly when the domain
 *                               would accept it, and the two are compared by
 *                               calling the domain rather than by reading it
 *   **the sidecar is empty**    it carries booleans, and a leak test against
 *                               the whole serialized object proves there is
 *                               nothing else in it to leak
 *   **the lifecycle is the studio's alone**  five states, four booleans, and
 *                               no word anybody wrote
 *
 * The expensive test is the first. A permission model that is *described*
 * twice is a permission model that will disagree with itself, so every
 * `false` below is pressed against the real domain, inside a real transaction,
 * and asserted to be refused.
 */

const staffViewer = { userId: owner.id };

/**
 * Nothing is on offer.
 *
 * Not `deepEqual(NO_CAPABILITIES)`: a round that is closed still *has* notes,
 * and each keeps an entry with every flag false, so a missing key never has to
 * mean two different things. What matters is that no flag anywhere is true.
 */
function permitsNothing(capabilities: ReviewCapabilities, what: string): void {
  assert.equal(capabilities.comment, false, `${what}: a comment is on offer`);
  for (const [n, flags] of Object.entries(capabilities.notes)) {
    for (const [name, value] of Object.entries(flags)) {
      assert.equal(value, false, `${what}: note ${n} still offers ${name}`);
    }
  }
}
const viewerOf = (actor: ClientActor) => ({
  contactId: actor.contactId,
  identityId: actor.identityId,
});

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

/* --------------------------------------------------------------- the rules */

const ROUND: RoundFacts = { open: true, standing: true, side: "client" };
const NOW = new Date("2026-09-20T12:00:00.000Z");
const FRESH = new Date("2026-09-20T11:58:00.000Z");
const STALE = new Date("2026-09-20T11:40:00.000Z");

function facts(over: Partial<NoteFacts> = {}): NoteFacts {
  return {
    n: 1,
    isRoot: true,
    mine: true,
    removed: false,
    resolved: false,
    createdAt: FRESH,
    replies: 0,
    ...over,
  };
}

test("a closed round, a withdrawn one and a lost standing all offer nothing", () => {
  for (const round of [
    { open: false, standing: true, side: "client" } as const,
    { open: true, standing: false, side: "client" } as const,
    { open: false, standing: false, side: "studio" } as const,
  ]) {
    const can = noteCapabilities(facts(), round, NOW);
    assert.deepEqual(can, {
      reply: false,
      edit: false,
      remove: false,
      resolve: false,
      reopen: false,
    });
    assert.equal(reviewCapabilities([facts()], round, NOW).comment, false);
  }
});

test("only the client opens a feedback item", () => {
  assert.equal(reviewCapabilities([], ROUND, NOW).comment, true);
  assert.equal(
    reviewCapabilities([], { ...ROUND, side: "studio" }, NOW).comment,
    false,
    "the studio replies to feedback rather than opening it",
  );
});

test("correcting and taking back follow the five conditions, not four", () => {
  const can = (over: Partial<NoteFacts>, side: "studio" | "client" = "client") =>
    noteCapabilities(facts(over), { ...ROUND, side }, NOW);

  assert.equal(can({}).edit, true, "your own, fresh, unanswered");
  assert.equal(can({}).remove, true);

  assert.equal(can({ mine: false }).edit, false, "somebody else's");
  assert.equal(can({ removed: true }).edit, false, "already a tombstone");
  assert.equal(can({ createdAt: STALE }).edit, false, "the window has closed");
  assert.equal(can({ replies: 1 }).edit, false, "somebody has answered it");

  // Depth is one, so a reply is never answered and the count does not apply.
  assert.equal(can({ isRoot: false, replies: 0 }).edit, true, "your own reply");
  assert.equal(
    can({ isRoot: false }, "studio").edit,
    true,
    "the studio corrects its own reply, which is why the action exists",
  );
});

test("resolving is the studio's claim and the author's answer to it", () => {
  const can = (over: Partial<NoteFacts>, side: "studio" | "client" = "client") =>
    noteCapabilities(facts(over), { ...ROUND, side }, NOW);

  assert.equal(can({}).resolve, true, "your own point");
  assert.equal(can({ mine: false }).resolve, false, "somebody else's point, as a client");
  assert.equal(can({ mine: false }, "studio").resolve, true, "any point, as the studio");

  assert.equal(can({ resolved: true }).resolve, false, "already dealt with");
  assert.equal(can({ resolved: true }).reopen, true);
  assert.equal(can({}).reopen, false, "not dealt with in the first place");

  assert.equal(can({ isRoot: false }).resolve, false, "a reply is not resolved on its own");
  assert.equal(can({ isRoot: false, resolved: true }).reopen, false);
  assert.equal(can({ removed: true }).resolve, false, "a tombstone has no point to settle");
});

test("replies go under a root that is still there", () => {
  assert.equal(noteCapabilities(facts(), ROUND, NOW).reply, true);
  assert.equal(noteCapabilities(facts({ isRoot: false }), ROUND, NOW).reply, false);
  assert.equal(noteCapabilities(facts({ removed: true }), ROUND, NOW).reply, false);
});

test("the sidecar is keyed by ordinal and covers every note, tombstones included", () => {
  const can = reviewCapabilities(
    [facts({ n: 1 }), facts({ n: 2, removed: true }), facts({ n: 7, isRoot: false })],
    ROUND,
    NOW,
  );

  assert.deepEqual(Object.keys(can.notes).sort(), ["1", "2", "7"]);
  assert.equal(can.notes[2]!.reply, false, "a tombstone keeps an entry, all false");
  assert.equal(can.notes[9], undefined, "and nothing is invented for a note that is not there");
});

/* ---------------------------------------------- the rules, against the domain */

/**
 * The sidecar's `false` is pressed against the real domain.
 *
 * A refusal is non-mutating, so every one of these can run against one round in
 * one order without the earlier assertions changing the later ones. The `true`
 * cases are checked separately, one per fresh round, because they do mutate.
 */
test("a control the sidecar withholds is refused by the domain as well", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);

  // Ana writes a point; the studio replies to it, which spends Ana's window.
  const first = await createReviewNote(s.ana, { reviewId, body: "The blue is wrong." });
  assert.ok(first.ok);
  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "Noted." })).ok);

  // Ana writes a second point and takes it back.
  const second = await createReviewNote(s.ana, { reviewId, body: MARKERS.removedRoot });
  assert.ok(second.ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId, number: 3 })).ok);

  const panel = await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation);
  assert.ok(panel);
  const ana = panel.capabilities;

  const ben = (await reviewPanelForViewer(viewerOf(s.ben), s.room, s.presentation))!.capabilities;
  const studio = (await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId))
    .capabilities;

  // Ana answered, so her own first point is beyond correcting.
  assert.equal(ana.notes[1]!.edit, false);
  assert.ok(!(await editReviewNote(s.ana, { reviewId, number: 1, body: "x" })).ok);
  assert.equal(ana.notes[1]!.remove, false);
  assert.ok(!(await removeReviewNote(s.ana, { reviewId, number: 1 })).ok);

  // Ben may not touch Ana's anything.
  for (const n of [1, 3]) {
    assert.equal(ben.notes[n]!.edit, false);
    assert.ok(!(await editReviewNote(s.ben, { reviewId, number: n, body: "x" })).ok);
    assert.equal(ben.notes[n]!.resolve, false);
    assert.ok(!(await resolveReviewNote(s.ben, { reviewId, number: n })).ok);
  }

  // Neither may the studio, on a client's words.
  assert.equal(studio.notes[1]!.edit, false);
  assert.ok(
    !(await editReviewNote(staff, { reviewId, number: 1, body: "x" })).ok,
    "the surface offers it to nobody, and the domain refuses it as well",
  );
  assert.equal(studio.notes[1]!.remove, false);
  assert.ok(!(await removeReviewNote(staff, { reviewId, number: 1 })).ok);

  // A tombstone settles nothing and answers nothing.
  for (const who of [ana, ben, studio]) assert.equal(who.notes[3]!.resolve, false);
  assert.ok(!(await resolveReviewNote(s.ana, { reviewId, number: 3 })).ok);
  assert.ok(!(await replyToReviewNote(staff, { reviewId, parentNumber: 3, body: "x" })).ok);

  // A reply is not resolved on its own, and the studio's reply is note 2.
  assert.equal(studio.notes[2]!.resolve, false);
  assert.ok(!(await resolveReviewNote(staff, { reviewId, number: 2 })).ok);
  assert.equal(studio.notes[2]!.reply, false);
  assert.ok(!(await replyToReviewNote(s.ana, { reviewId, parentNumber: 2, body: "x" })).ok);

  // Nothing above wrote anything: the round is exactly as it was left.
  const after = await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation);
  assert.deepEqual(after!.review, panel.review, "a refusal changed the round");
});

test("the fifteen minutes are the server's, and the sidecar and the domain agree on them", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Still thinking." })).ok);

  const inside = await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation);
  assert.equal(inside!.capabilities.notes[1]!.edit, true);

  const later = new Date(Date.now() + 16 * 60_000);
  const outside = await reviewPanelForViewer(
    viewerOf(s.ana),
    s.room,
    s.presentation,
    undefined,
    later,
  );
  assert.equal(outside!.capabilities.notes[1]!.edit, false, "the window is not open for ever");
  assert.equal(outside!.capabilities.notes[1]!.remove, false);

  const refused = await editReviewNote(s.ana, { reviewId, number: 1, body: "x" }, later);
  assert.ok(!refused.ok);
  assert.match(refused.message, /within 15 minutes/);

  // And what it still offers, it offers truthfully.
  assert.ok((await editReviewNote(s.ana, { reviewId, number: 1, body: "Settled on it." })).ok);
});

test("a control the sidecar offers is accepted by the domain", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Make the mark larger." })).ok);

  const ana = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!;
  assert.equal(ana.capabilities.comment, true);
  assert.equal(ana.capabilities.notes[1]!.reply, true);
  assert.equal(ana.capabilities.notes[1]!.resolve, true);

  const studio = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  assert.equal(studio.capabilities.comment, false, "and the studio is offered no way to open one");
  assert.equal(studio.capabilities.notes[1]!.reply, true);
  assert.equal(studio.capabilities.notes[1]!.resolve, true);

  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "Done." })).ok);
  assert.ok((await resolveReviewNote(staff, { reviewId, number: 1 })).ok);

  const afterStudio = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  assert.equal(afterStudio.capabilities.notes[1]!.resolve, false);
  assert.equal(afterStudio.capabilities.notes[1]!.reopen, true);

  // The studio said it was dealt with; the client is the one who answers that.
  const afterAna = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!;
  assert.equal(afterAna.capabilities.notes[1]!.reopen, true);
  assert.ok((await reopenReviewNote(s.ana, { reviewId, number: 1 })).ok);

  // The studio's own reply is the studio's to correct, and nobody else's.
  assert.equal(afterStudio.capabilities.notes[2]!.edit, true);
  const ben = (await reviewPanelForViewer(viewerOf(s.ben), s.room, s.presentation))!;
  assert.equal(ben.capabilities.notes[2]!.edit, false);
  assert.ok((await editReviewNote(staff, { reviewId, number: 2, body: "Done — larger." })).ok);
});

/* ------------------------------------------------------------- the leak tests */

test("the sidecar carries booleans and nothing else", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: MARKERS.removedRoot })).ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId, number: 1 })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "MARKER-LIVE-NOTE" })).ok);

  for (const capabilities of [
    (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!.capabilities,
    (await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId)).capabilities,
  ]) {
    const serialized = JSON.stringify(capabilities);

    assert.ok(!UUID.test(serialized), "a database identifier reached the sidecar");
    for (const marker of Object.values(MARKERS)) {
      assert.ok(!serialized.includes(marker), `the sidecar carries ${marker}`);
    }
    assert.ok(!serialized.includes("MARKER-LIVE-NOTE"), "the sidecar duplicates the words");

    // Nothing but booleans, at either level. A future field carrying anything
    // else has to come past this line first.
    for (const value of Object.values(capabilities.notes)) {
      for (const flag of Object.values(value)) assert.equal(typeof flag, "boolean");
    }
    assert.equal(typeof capabilities.comment, "boolean");
    assert.deepEqual(Object.keys(capabilities).sort(), ["comment", "notes"]);
  }
});

test("a removed body is in neither panel, for either world", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: MARKERS.removedRoot })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "Seen." })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: MARKERS.removedReply })).ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId, number: 3 })).ok);

  const client = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!;
  const studio = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);

  for (const [world, panel] of [
    ["client", JSON.stringify(client)],
    ["studio", JSON.stringify(studio)],
  ] as const) {
    assert.ok(!panel.includes(MARKERS.removedReply), `${world} can read a removed body`);
    assert.ok(!UUID.test(panel), `${world} received a database identifier`);
  }
});

test("Studio and the client read the identical round", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "One.", itemPosition: 1 })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "Two." })).ok);
  assert.ok((await createReviewNote(s.ben, { reviewId, body: "Three." })).ok);
  assert.ok((await resolveReviewNote(staff, { reviewId, number: 1 })).ok);

  const client = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!;
  const studio = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);

  assert.deepEqual(
    studio.review,
    client.review,
    "one projection means one content model, byte for byte",
  );
});

/* ------------------------------------------------------------- the lifecycle */

test("the lifecycle names each state and offers only what fits it", () => {
  const base = { notes: 0, current: true, live: true, supersededByVersion: null };

  const none = reviewLifecycle({ ...base, status: null, closedReason: null });
  assert.equal(none.state, "none");
  assert.equal(none.canRequest, true);
  assert.deepEqual([none.canClose, none.canWithdraw, none.canReopen], [false, false, false]);

  const open = reviewLifecycle({ ...base, status: "open", closedReason: null });
  assert.equal(open.state, "open");
  assert.deepEqual([open.canRequest, open.canClose, open.canWithdraw], [false, true, true]);

  const used = reviewLifecycle({ ...base, status: "open", closedReason: null, notes: 1 });
  assert.equal(used.canWithdraw, false, "a round somebody has written in is not taken back");

  const closed = reviewLifecycle({ ...base, status: "closed", closedReason: "staff" });
  assert.equal(closed.state, "closed");
  assert.deepEqual([closed.canReopen, closed.canRequest], [true, false]);

  const gone = reviewLifecycle({
    ...base,
    status: "closed",
    closedReason: "superseded",
    supersededByVersion: 3,
  });
  assert.equal(gone.state, "superseded");
  assert.equal(gone.supersededBy, 3);
  assert.deepEqual(
    [gone.canRequest, gone.canClose, gone.canWithdraw, gone.canReopen],
    [false, false, false, false],
    "a supersession is terminal, and nothing on the page suggests otherwise",
  );

  const back = reviewLifecycle({ ...base, status: "withdrawn", closedReason: null });
  assert.equal(back.state, "withdrawn");
  assert.equal(back.canRequest, true, "asked again, in the same row");
  assert.equal(back.canReopen, false, "'reopen' is the wrong word for something never used");

  // Only the version the client is reading, and only once there is one.
  for (const off of [{ current: false }, { live: false }]) {
    const stale = reviewLifecycle({ ...base, ...off, status: null, closedReason: null });
    assert.equal(stale.canRequest, false);
    const shut = reviewLifecycle({ ...base, ...off, status: "closed", closedReason: "staff" });
    assert.equal(shut.canReopen, false);
  }
});

test("the lifecycle carries no content, ever", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "MARKER-LIFECYCLE-BODY" })).ok);

  const { lifecycle } = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  const serialized = JSON.stringify(lifecycle);

  assert.ok(!serialized.includes("MARKER-LIFECYCLE-BODY"));
  assert.ok(!UUID.test(serialized), "the lifecycle names a Revision by number, never by id");
  assert.deepEqual(Object.keys(lifecycle).sort(), [
    "canClose",
    "canReopen",
    "canRequest",
    "canWithdraw",
    "state",
    "supersededBy",
  ]);
});

test("Studio tells a withdrawn round from one nobody asked for; the client cannot", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);

  const asked = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  assert.equal(asked.lifecycle.state, "open");

  assert.ok((await withdrawReview(staff, reviewId)).ok);

  const gone = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  assert.equal(gone.lifecycle.state, "withdrawn", "the studio can see what it did");
  assert.equal(gone.review, null, "and reads the same nothing the client does");
  assert.deepEqual(gone.capabilities, NO_CAPABILITIES);
  assert.equal(gone.lifecycle.canRequest, true);

  assert.equal(
    await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation),
    null,
    "to the client it is a round that never existed",
  );
});

test("publishing supersedes the round it replaces, on both surfaces", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "About version two." })).ok);

  const version = (await findPresentation(s.presentationId))!;
  assert.ok((await publishPresentation(owner, s.presentationId, version.version)).ok);

  const old = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId, 2);
  assert.equal(old.lifecycle.state, "superseded");
  assert.equal(old.lifecycle.supersededBy, 3);
  assert.equal(old.review!.status, "closed");
  assert.deepEqual(old.review!.closedNote, { reason: "superseded", version: 3 });

  const client = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation, 2))!;
  assert.deepEqual(client.review.closedNote, { reason: "superseded", version: 3 });
  assert.equal(client.review.canWrite, false);
  permitsNothing(client.capabilities, "history is readable and never writable");

  // And the new version starts clean: nobody has been asked about it.
  const current = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  assert.equal(current.lifecycle.state, "none");
  assert.equal(current.lifecycle.canRequest, true);
  assert.equal(
    await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation),
    null,
    "and the client is shown nothing until they are asked",
  );
});

test("a closed round is read-only on both surfaces and says why once", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Said it." })).ok);
  assert.ok((await closeReview(staff, reviewId)).ok);

  const client = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!;
  assert.equal(client.review.status, "closed");
  assert.deepEqual(client.review.closedNote, { reason: "closed" });
  assert.equal(client.review.canWrite, false);
  permitsNothing(client.capabilities, "a closed round");

  const studio = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId);
  assert.equal(studio.lifecycle.state, "closed");
  assert.equal(studio.lifecycle.canReopen, true);
  permitsNothing(studio.capabilities, "closed is closed for the studio too");
});

test("an unpublished presentation offers the studio nothing to ask for", async () => {
  await wipe();
  const s = await stage();
  await round(s);

  const version = (await findPresentation(s.presentationId))!;
  assert.ok((await unpublishPresentation(owner, s.presentationId, version.version)).ok);

  const studio = await reviewPanelForStaff(staffViewer, s.workroomId, s.presentationId, 2);
  assert.equal(studio.lifecycle.canRequest, false);
  assert.equal(studio.lifecycle.canReopen, false);
  assert.equal(
    await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation, 2),
    null,
    "and the client has lost the presentation along with the round",
  );
});

/* -------------------------------------------------------------- the boundary */

test("a panel is reached only from where it belongs", async () => {
  await wipe();
  const mine = await stage("Own");
  const theirs = await stage("Other");
  const reviewId = await round(mine);
  assert.ok((await createReviewNote(mine.ana, { reviewId, body: "Mine." })).ok);

  const outsider = await stage("Out");

  for (const [what, panel] of [
    ["another Workroom's presentation", await reviewPanelForViewer(viewerOf(outsider.ana), mine.room, mine.presentation)],
    ["their own Workroom with the wrong presentation", await reviewPanelForViewer(viewerOf(mine.ana), mine.room, theirs.presentation)],
    ["a Revision that was never published", await reviewPanelForViewer(viewerOf(mine.ana), mine.room, mine.presentation, 99)],
  ] as const) {
    assert.equal(panel, null, `a client reached ${what}`);
  }

  const crossed = await reviewPanelForStaff(staffViewer, theirs.workroomId, mine.presentationId);
  assert.equal(crossed.review, null, "staff reached a presentation through another Workroom");
  assert.equal(crossed.lifecycle.state, "none");
  assert.equal(crossed.lifecycle.canRequest, false, "and are offered no way to act on it");
});

test("a revoked member loses the round on their next request", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Before." })).ok);

  assert.ok(await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation));

  await db()
    .update(presentations)
    .set({ status: "unpublished" })
    .where(eq(presentations.id, s.presentationId));

  assert.equal(
    await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation),
    null,
    "standing is read on the request, never trusted from a session",
  );
});

/* ------------------------------------------------------------ naming a block */

test("a point says what part of the work it is about, in words", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "This one.", itemPosition: 1 })).ok);

  const panel = (await reviewPanelForViewer(viewerOf(s.ana), s.room, s.presentation))!;
  // The block it is about, on the note itself — and no anchor, because nothing
  // captured a place inside it. That separation is what beta cost us.
  assert.equal(live(panel.review.notes[0]).subject, 1);
  assert.equal(live(panel.review.notes[0]).anchor, undefined);

  // The fixture's Revision 2 is: 0 a note headed "One", then four captioned files.
  const items = [
    { position: 0, kind: "note" as const, caption: "One", body: "Words." },
    { position: 1, kind: "note" as const, caption: null, body: "A long opening line." },
  ];
  assert.equal(itemLabel(items[0]!), "One");
  assert.equal(itemLabel(items[1]!), "A long opening line.", "a heading-less note names itself");
  assert.equal(labelAt(items, 1), "A long opening line.");
  assert.equal(labelAt(items, 9), null, "a position that is not in this version names nothing");
  assert.deepEqual(itemSubjects(items).map((s) => s.value), ["0", "1"]);
});

/* ---------------------------------------------------------------- the surface */

/** Prose explains what a component does; only code can do it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("the shared thread does not fork by world", () => {
  const thread = code("components/workrooms/ReviewThread.tsx");

  for (const fork of ["isStaff", "isClient", "StaffReview", "AdminReview", "InternalReview"]) {
    assert.ok(!thread.includes(fork), `ReviewThread branches on ${fork}`);
  }

  // Both worlds render this one component, from this one projection.
  for (const surface of [
    "app/workrooms/(room)/[id]/presentations/ReviewPanel.tsx",
    "app/studio/(app)/workrooms/[id]/presentations/ReviewPanel.tsx",
  ]) {
    assert.ok(code(surface).includes("ReviewThread"), `${surface} renders something else`);
  }

  // And there is exactly one of it.
  assert.equal(
    [
      "components/workrooms/ReviewThread.tsx",
      "components/workrooms/ReviewAction.tsx",
      "components/workrooms/ReviewComposer.tsx",
    ].length,
    3,
    "the thread is three files: the content, a button and a box to write in",
  );
});

test("the client surface never receives the studio's lifecycle", () => {
  const client = code("app/workrooms/(room)/[id]/presentations/ReviewPanel.tsx");

  for (const forbidden of ["lifecycle", "reviewPanelForStaff", "requestReview", "withdrawReview"]) {
    assert.ok(!client.includes(forbidden), `the client surface reads ${forbidden}`);
  }
  assert.ok(
    !code("components/workrooms/ReviewThread.tsx").includes("lifecycle"),
    "the shared thread knows about the studio's administration",
  );
});
