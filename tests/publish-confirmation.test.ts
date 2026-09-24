import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import {
  filesToShareOnPublish,
  findPresentation,
  listRevisions,
  publishPresentation,
  unpublishPresentation,
} from "../lib/db/presentations.ts";
import {
  closeReview,
  createReviewNote,
  openRoundOnCurrentRevision,
  requestReview,
  withdrawReview,
} from "../lib/db/reviews.ts";
import { presentationReviews } from "../lib/db/schema.ts";
import { publishConfirmation } from "../lib/workrooms/publish-copy.ts";
import { clearOwner, owner, seedOwner, stage, staff, wipe, type Stage } from "./support/review-stage.ts";

/**
 * What the studio is told before it publishes over a round of feedback.
 *
 * Beta found the dialog saying only that the client would see something new,
 * while the same press was about to end a conversation with that client for
 * good. These tests hold the disclosure to the behaviour: for each state a
 * round can be in, the copy is read **and then the publish is performed**, and
 * the round is checked afterwards. A warning that promises a consequence the
 * transaction does not have is as wrong as a consequence nobody was warned of.
 *
 * Publishing itself is not changed by any of this, and the last test here says
 * so the only way that counts — by exercising it.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

const FEEDBACK = /Feedback on .* will close/;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** What the Studio page would put in the dialog right now, from the same reads it makes. */
async function dialog(s: Stage) {
  const presentation = (await findPresentation(s.presentationId))!;
  const revisions = await listRevisions(s.presentationId);
  return publishConfirmation({
    firstPublish: revisions.length === 0,
    sharing: (await filesToShareOnPublish(s.presentationId)).length,
    replacing:
      revisions.find((entry) => entry.id === presentation.currentRevisionId)?.revisionNumber ?? null,
    closesFeedback: await openRoundOnCurrentRevision(s.workroomId, s.presentationId),
  });
}

/** Publish, and report what became of the round on the version it replaced. */
async function publishAndInspect(s: Stage, reviewId: string | null) {
  const presentation = (await findPresentation(s.presentationId))!;
  assert.ok((await publishPresentation(owner, s.presentationId, presentation.version)).ok);
  if (!reviewId) return null;

  const [row] = await db()
    .select({ status: presentationReviews.status, reason: presentationReviews.closedReason })
    .from(presentationReviews)
    .where(eq(presentationReviews.id, reviewId));
  return row!;
}

/* ------------------------------------------------------------- the words */

test("the copy names each consequence that is true, and no other", () => {
  assert.deepEqual(
    publishConfirmation({ firstPublish: true, sharing: 0, replacing: null, closesFeedback: false }),
    { title: "Publish presentation?", message: "The client can open it from that moment." },
  );
  // The line verified by hand on beta, unchanged.
  assert.deepEqual(
    publishConfirmation({ firstPublish: true, sharing: 1, replacing: null, closesFeedback: false }),
    { title: "Publish presentation?", message: "One file will also be shared with the client." },
  );

  assert.deepEqual(
    publishConfirmation({ firstPublish: false, sharing: 0, replacing: 2, closesFeedback: false }),
    {
      title: "Publish a new version?",
      message: "The client will see this instead of Version 2.",
    },
  );

  // The defect beta found, corrected.
  assert.deepEqual(
    publishConfirmation({ firstPublish: false, sharing: 0, replacing: 2, closesFeedback: true }),
    {
      title: "Publish a new version?",
      message:
        "The client will see this instead of Version 2. Feedback on Version 2 will close and remain available as read-only history.",
    },
  );

  // Added to the files consequence, never substituted for it.
  assert.equal(
    publishConfirmation({ firstPublish: false, sharing: 3, replacing: 4, closesFeedback: true })
      .message,
    "3 files will also be shared with the client. Feedback on Version 4 will close and remain available as read-only history.",
  );

  // No number to hand is said plainly rather than guessed.
  assert.equal(
    publishConfirmation({ firstPublish: false, sharing: 0, replacing: null, closesFeedback: true })
      .message,
    "The client will see this instead of the current version. Feedback on the current version will close and remain available as read-only history.",
  );
});

/* ------------------------------------ each round state, against the behaviour */

test("an open round: the dialog says it will close, and publishing closes it", async () => {
  await wipe();
  const s = await stage();
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const made = await requestReview(staff, current);
  assert.ok(made.ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: made.value, body: "A real point." })).ok);

  const said = await dialog(s);
  assert.match(said.message, FEEDBACK, "an open round was not disclosed");
  assert.match(said.message, /Version 2/, "the version was not named");
  assert.ok(!UUID.test(said.message), "the dialog names a row by its id");

  assert.deepEqual(await publishAndInspect(s, made.value), { status: "closed", reason: "superseded" });
});

test("no round: nothing is said about feedback, and there is none to close", async () => {
  await wipe();
  const s = await stage();

  const said = await dialog(s);
  assert.doesNotMatch(said.message, FEEDBACK, "a round that never existed was said to close");
  assert.equal(said.message, "The client will see this instead of Version 2.");

  await publishAndInspect(s, null);
  assert.equal(await openRoundOnCurrentRevision(s.workroomId, s.presentationId), false);
});

test("a round the studio closed: not said to close again, and it keeps its reason", async () => {
  await wipe();
  const s = await stage();
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const made = await requestReview(staff, current);
  assert.ok(made.ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: made.value, body: "Said." })).ok);
  assert.ok((await closeReview(staff, made.value)).ok);

  const said = await dialog(s);
  assert.doesNotMatch(said.message, FEEDBACK, "a closed round was said to close");

  assert.deepEqual(await publishAndInspect(s, made.value), { status: "closed", reason: "staff" });
});

test("a withdrawn round: never mentioned, and it stays withdrawn", async () => {
  await wipe();
  const s = await stage();
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const made = await requestReview(staff, current);
  assert.ok(made.ok);
  assert.ok((await withdrawReview(staff, made.value)).ok);

  const said = await dialog(s);
  // A request the studio took back is administration, not history, and a
  // dialog that alluded to it would surface what the withdrawal hid.
  assert.doesNotMatch(said.message, /[Ff]eedback|[Rr]eview|withdraw/, "a withdrawn round surfaced");

  assert.deepEqual(await publishAndInspect(s, made.value), { status: "withdrawn", reason: null });
});

test("an open round on a withdrawn presentation is still disclosed, because it still closes", async () => {
  // The case a "published only" reader would have got wrong. Withdrawing the
  // presentation leaves the round and the pointer where they are, and a later
  // publish supersedes that round exactly as it would have before — so the
  // dialog has to say so here too.
  await wipe();
  const s = await stage();
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const made = await requestReview(staff, current);
  assert.ok(made.ok);

  const withdrawing = (await findPresentation(s.presentationId))!;
  assert.ok((await unpublishPresentation(owner, s.presentationId, withdrawing.version)).ok);

  assert.match((await dialog(s)).message, FEEDBACK);
  assert.deepEqual(await publishAndInspect(s, made.value), { status: "closed", reason: "superseded" });
});

test("the reader is scoped to its own Workroom", async () => {
  await wipe();
  const mine = await stage("Own");
  const theirs = await stage("Other");
  const current = (await findPresentation(mine.presentationId))!.currentRevisionId!;
  assert.ok((await requestReview(staff, current)).ok);

  assert.equal(await openRoundOnCurrentRevision(mine.workroomId, mine.presentationId), true);
  assert.equal(
    await openRoundOnCurrentRevision(theirs.workroomId, mine.presentationId),
    false,
    "a presentation was reached through another Workroom",
  );
});
