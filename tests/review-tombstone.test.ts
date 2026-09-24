import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { closeDb } from "../lib/db/index.ts";
import {
  createReviewNote,
  removeReviewNote,
  replyToReviewNote,
  resolveReviewNote,
  reviewPanelForStaff,
  reviewPanelForViewer,
} from "../lib/db/reviews.ts";
import { presentationForViewer } from "../lib/db/presentations.ts";
import { itemSubjects } from "../lib/workrooms/presentation-view.ts";
import {
  clearOwner,
  live,
  owner,
  round,
  seedOwner,
  stage,
  staff,
  tombstone,
  wipe,
  MARKERS,
  type Stage,
} from "./support/review-stage.ts";

/**
 * What survives a removal, and what must not.
 *
 * Beta found a tombstone rendered inside the note's own header: *Yehuda Weller
 * · 23 Sept, 20:44 · This was taken back.* The words were gone and everything
 * around them was still there, which narrates who took something back and
 * when — the record a removal exists to stop leaving.
 *
 * The correction is not a check in the renderer. A removed note is a **different
 * type**, carrying its ordinal and the fact that it happened, and nothing else.
 * Reading an author off one does not compile, and there is nothing in the
 * serialized response to find — so these tests assert the value's exact shape
 * rather than the markup's, and the rendered markup is asserted over HTTP in
 * `reviews-http.test.ts` where it is the real thing rather than a simulation.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

const viewerOf = (s: Stage) => ({ contactId: s.ana.contactId, identityId: s.ana.identityId });

/** Both worlds' view of one round. They must always be the same object. */
async function worlds(s: Stage) {
  const asClient = await reviewPanelForViewer(viewerOf(s), s.room, s.presentation);
  const asStudio = await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId);
  assert.ok(asClient);
  assert.ok(asStudio.review);
  assert.deepEqual(asStudio.review, asClient.review, "the two worlds read different rounds");
  return { client: asClient.review, studio: asStudio.review };
}

/* ----------------------------------------------------------- a removed root */

test("a removed root is its ordinal and the fact that it happened", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);

  // Everything a note can hold, before it is taken back: a body, an author, a
  // block it is about, and somebody's claim that it was dealt with.
  const view = (await presentationForViewer(s.ana.contactId, s.room, s.presentation))!;
  const block = itemSubjects(view.items)[1]!;

  const made = await createReviewNote(s.ana, {
    reviewId,
    body: MARKERS.removedRoot,
    itemPosition: Number(block.value),
  });
  assert.ok(made.ok);
  assert.ok((await resolveReviewNote(staff, { reviewId, number: 1 })).ok);

  const before = await worlds(s);
  assert.equal(live(before.client.notes[0]).subject, Number(block.value));
  assert.equal(live(before.client.notes[0]).resolved, true);

  assert.ok((await removeReviewNote(s.ana, { reviewId, number: 1 })).ok);

  const after = await worlds(s);
  for (const [world, review] of [
    ["the client", after.client],
    ["Studio", after.studio],
  ] as const) {
    const note = review.notes[0]!;
    tombstone(note, `${world}'s removed root`);
    assert.deepEqual(note, { n: 1, removed: true }, `${world} kept more than the ordinal`);
  }
});

test("a removed reply is the same, and sits where it always sat", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);

  assert.ok((await createReviewNote(s.ana, { reviewId, body: "A point." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "One." })).ok);
  assert.ok(
    (await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: MARKERS.removedReply })).ok,
  );
  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "Three." })).ok);
  assert.ok((await removeReviewNote(staff, { reviewId, number: 3 })).ok);

  const { client, studio } = await worlds(s);
  for (const [world, review] of [
    ["the client", client],
    ["Studio", studio],
  ] as const) {
    const replies = live(review.notes[0]).replies;
    assert.deepEqual(
      replies.map((reply) => reply.n),
      [2, 3, 4],
      `${world}: a removal moved the conversation around`,
    );
    tombstone(replies[1], `${world}'s removed reply`);
    assert.deepEqual(replies[1], { n: 3, removed: true }, `${world} kept more than the ordinal`);
  }
});

/* ---------------------------------------------------- the domain invariant */

test("a removed root has no replies, and can never gain one", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);

  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Taken back." })).ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId, number: 1 })).ok);

  // Removal is refused once anything has answered, and an answer is refused
  // once it is removed — so a tombstone has nothing under it by construction,
  // which is why it does not carry `replies` at all.
  const answered = await replyToReviewNote(staff, { reviewId, parentNumber: 1, body: "Late." });
  assert.ok(!answered.ok, "a tombstone accepted a reply");
  assert.match(answered.ok ? "" : answered.message, /removed/);

  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Answered." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId, parentNumber: 2, body: "Yes." })).ok);
  const late = await removeReviewNote(s.ana, { reviewId, number: 2 });
  assert.ok(!late.ok, "a root with a reply under it was removed");
  assert.match(late.ok ? "" : late.message, /replied/);
});

/* --------------------------------------------------------------- the leak */

test("nothing a removed note held reaches either world", async () => {
  await wipe();
  const s = await stage();
  const reviewId = await round(s);

  const view = (await presentationForViewer(s.ana.contactId, s.room, s.presentation))!;
  const block = itemSubjects(view.items)[2]!;

  // Written by Ben and resolved by the studio, so the author name and the
  // resolver name both belong to this note and to nothing else in the round.
  assert.ok(
    (await createReviewNote(s.ben, {
      reviewId,
      body: MARKERS.removedRoot,
      itemPosition: Number(block.value),
    })).ok,
  );
  assert.ok((await resolveReviewNote(staff, { reviewId, number: 1 })).ok);
  assert.ok((await removeReviewNote(s.ben, { reviewId, number: 1 })).ok);

  // One live note, so the assertions below are not passing against an empty
  // round — Ana and her words must still be there.
  assert.ok((await createReviewNote(s.ana, { reviewId, body: "Still here." })).ok);

  const { client, studio } = await worlds(s);
  for (const [world, review] of [
    ["the client", client],
    ["Studio", studio],
  ] as const) {
    const serialized = JSON.stringify(review);

    for (const [what, marker] of [
      ["body", MARKERS.removedRoot],
      ["author", s.ben.name],
      ["resolver", owner.name],
    ] as const) {
      assert.ok(!serialized.includes(marker), `${world}: a removed note kept its ${what}`);
    }

    // No timestamp either: the only date left is the round's own request.
    assert.equal(
      (serialized.match(/"at":/g) ?? []).length,
      1,
      `${world}: a tombstone kept a timestamp`,
    );

    assert.ok(serialized.includes("Still here."), `${world} lost the live note`);
    assert.ok(serialized.includes(s.ana.name), `${world} lost the live author`);
  }
});

/* ------------------------------------------------------------ the renderer */

/** Prose explains what a component does; only code can do it. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("the thread has one tombstone, said one way, in both positions", () => {
  const thread = code("components/workrooms/ReviewThread.tsx");

  assert.ok(thread.includes("Comment removed"), "the tombstone's words are not in the thread");
  assert.ok(
    !thread.includes("This was taken back"),
    "the old tombstone copy is still here",
  );

  // One component renders it, used from both the root branch and the reply
  // branch — not two copies of a line that can drift into two sentences.
  assert.equal(
    (thread.match(/Comment removed/g) ?? []).length,
    1,
    "the tombstone's words are written more than once",
  );
  assert.equal(
    (thread.match(/<Tombstone \/>/g) ?? []).length,
    2,
    "a tombstone is not rendered from exactly the two places a note can sit",
  );

  // And the short-circuit comes first in each branch: the header below it
  // cannot run for a removed note.
  for (const [what, guard] of [
    ["a reply", "if (reply.removed) {"],
    ["a root", "if (note.removed) {"],
  ] as const) {
    const at = thread.indexOf(guard);
    assert.ok(at > -1, `${what} has no removed branch at all`);

    const head = thread.indexOf("styles.noteHead", at);
    const returned = thread.indexOf("</li>", at);
    assert.ok(returned > -1 && returned < head, `${what} reads its header before checking removed`);
  }
});
