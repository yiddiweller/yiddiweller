import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { asc, eq, sql } from "drizzle-orm";

import { closeDb, db } from "../lib/db/index.ts";
import {
  addFileItem,
  addNoteItem,
  findPresentation,
  listDraftRows,
  presentationForViewer,
  publishPresentation,
  removeItem,
  revisionForStaff,
} from "../lib/db/presentations.ts";
import {
  closeReview,
  createReviewNote,
  reopenReview,
  requestReview,
  reviewPanelForStaff,
  reviewPanelForViewer,
} from "../lib/db/reviews.ts";
import {
  presentationReviewNotes,
  presentationRevisionItems,
  workroomFiles,
} from "../lib/db/schema.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { itemLabel, itemSubjects, labelAt } from "../lib/workrooms/presentation-view.ts";
import { clearOwner, owner, seedOwner, stage, staff, wipe } from "./support/review-stage.ts";

/**
 * Which part of the work a point is about — the defect beta found, and the two
 * numbers behind it.
 *
 * A draft's `position` is an **ordering key**: `removeItem` leaves a gap and
 * `nextPosition` is `max + 1`, so the moment somebody drops a block the
 * sequence reads `0, 2, 3, 4`. A Revision's items were written **densely**, by
 * array index — `0, 1, 2, 3` — and the frozen snapshot kept the draft's
 * numbers. So one block had two different numbers depending on which table you
 * asked, and the Review path crossed between them twice:
 *
 *   the client's `<select>`  sends a snapshot position
 *   `createReviewNote`       resolves a `presentation_revision_items.position`
 *   the reader               returns a `presentation_revision_items.position`
 *   `labelAt`                looks that up among snapshot positions
 *
 * Measured against a real database before the fix: picking the fourth block
 * attached the note to the fifth, and picking the last block was refused
 * outright with *That part of the work is not in this version.* Both are the
 * same defect, and both are gone once there is one number.
 *
 * These tests are deliberately built on a draft that has had a block removed,
 * because a draft nobody has edited hides the whole thing.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

/** A file row, written straight in: this suite is about positions, not bytes. */
async function file(workroomId: string, name: string): Promise<string> {
  const id = uuidv7();
  await db().insert(workroomFiles).values({
    id,
    publicId: `f${id.replace(/-/g, "").slice(0, 25)}`,
    workroomId,
    displayName: name,
    originalFilename: name,
    contentType: "image/png",
    byteSize: 1024,
    storageKey: `w/${workroomId}/f/${id}/o`,
    storageEtag: `"${id}"`,
    status: "ready",
    visibility: "internal",
    createdBy: owner.id,
  });
  return id;
}

/**
 * A Presentation built the way a person builds one: blocks added, one of them
 * dropped, then published twice.
 *
 * Its Version 2 holds a note item and three files, one of them captioned
 * *Primary identity direction* — the block beta's client picked.
 */
async function edited() {
  const s = await stage();
  const v = async () => (await findPresentation(s.presentationId))!.version;

  // `stage()` leaves one note item and four files already published.
  const before = await listDraftRows(s.presentationId);
  const dropped = before[1]!;
  assert.ok((await removeItem(owner, s.presentationId, await v(), dropped.id)).ok);

  assert.ok(
    (await addFileItem(
      owner,
      s.presentationId,
      await v(),
      await file(s.workroomId, "Identity.png"),
      "Primary identity direction",
    )).ok,
  );
  assert.ok(
    (await addNoteItem(owner, s.presentationId, await v(), {
      caption: "",
      body: "A closing thought about the direction, with no heading on it.",
    })).ok,
  );

  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const presentation = (await findPresentation(s.presentationId))!;
  const client = (await presentationForViewer(s.ana.contactId, s.room, s.presentation))!;
  const studio = (await revisionForStaff(presentation, (await v()) && 3))!;
  const relational = await db()
    .select({ position: presentationRevisionItems.position, caption: presentationRevisionItems.caption })
    .from(presentationRevisionItems)
    .where(eq(presentationRevisionItems.presentationRevisionId, presentation.currentRevisionId!))
    .orderBy(asc(presentationRevisionItems.position));

  return { s, presentation, client, studio, relational };
}

/* -------------------------------------------------------- the two numbers */

test("a Revision has one set of positions, and the draft's gaps are not in it", async () => {
  await wipe();
  const { client, studio, relational } = await edited();

  const dense = relational.map((row) => row.position);
  assert.deepEqual(dense, [...dense.keys()], "revision items are not a dense sequence");

  assert.deepEqual(
    client.items.map((item) => item.position),
    dense,
    "the client's snapshot numbers its blocks differently from the Revision's items",
  );
  assert.deepEqual(
    studio.items.map((item) => item.position),
    dense,
    "Studio's snapshot numbers its blocks differently from the Revision's items",
  );

  // And the same number names the same block in both, which is the whole point.
  for (const row of relational) {
    const item = client.items.find((candidate) => candidate.position === row.position)!;
    assert.ok(item, `no block at position ${row.position}`);
    assert.equal(
      item.kind === "file" ? (item.caption ?? item.file.name) : (item.caption ?? "note"),
      row.caption ?? (item.kind === "note" ? item.caption ?? "note" : ""),
      `position ${row.position} names two different blocks`,
    );
  }
});

test("every subject the client can pick resolves to the block they picked", async () => {
  await wipe();
  const { s, presentation, client } = await edited();
  const reviewId = (await requestReview(staff, presentation.currentRevisionId!)) as { value: string };

  for (const option of itemSubjects(client.items)) {
    const made = await createReviewNote(s.ana, {
      reviewId: reviewId.value,
      body: `About ${option.label}.`,
      itemPosition: Number(option.value),
    });
    assert.ok(made.ok, `picking "${option.label}" was refused: ${made.ok ? "" : made.message}`);

    // The row the note is actually bolted to, read through its stored id
    // rather than through the number that was sent — which is the only way to
    // see an attachment land on the wrong block.
    const [attached] = await db()
      .select({ caption: presentationRevisionItems.caption, position: presentationRevisionItems.position })
      .from(presentationReviewNotes)
      .innerJoin(
        presentationRevisionItems,
        eq(presentationRevisionItems.id, presentationReviewNotes.revisionItemId),
      )
      .where(eq(presentationReviewNotes.id, sql`(SELECT id FROM presentation_review_notes WHERE number = ${made.value} AND presentation_review_id = ${reviewId.value})`));

    assert.ok(attached, `"${option.label}" stored no block at all`);
    assert.equal(
      attached.caption ?? labelAt(client.items, attached.position),
      option.label,
      `"${option.label}" is attached to "${attached.caption}"`,
    );

    const panel = (await reviewPanelForViewer(
      { contactId: s.ana.contactId, identityId: s.ana.identityId },
      s.room,
      s.presentation,
    ))!;
    const note = panel.review.notes.find((n) => n.n === made.value)!;

    assert.equal(note.subject, Number(option.value), `"${option.label}" lost its subject`);
    assert.equal(
      labelAt(client.items, note.subject!),
      option.label,
      `"${option.label}" now reads as something else`,
    );
  }
});

/* ------------------------------------------------------- the regression */

test("a point about a block carries its subject; a general point carries none", async () => {
  await wipe();
  const { s, presentation, client, studio } = await edited();
  const reviewId = (await requestReview(staff, presentation.currentRevisionId!)) as { value: string };

  const identity = itemSubjects(client.items).find(
    (option) => option.label === "Primary identity direction",
  )!;
  assert.ok(identity, "the fixture lost the block this defect was found on");

  const general = await createReviewNote(s.ana, {
    reviewId: reviewId.value,
    body: "Reads well overall.",
  });
  assert.ok(general.ok);

  // Item-level, and **no precise anchor** — which is all this build can
  // produce, and the case that stopped rendering.
  const point = await createReviewNote(s.ana, {
    reviewId: reviewId.value,
    body: "This one is the direction.",
    itemPosition: Number(identity.value),
  });
  assert.ok(point.ok, point.ok ? "" : point.message);

  const viewer = { contactId: s.ana.contactId, identityId: s.ana.identityId };
  const asClient = (await reviewPanelForViewer(viewer, s.room, s.presentation))!;
  const asStudio = await reviewPanelForStaff({ userId: owner.id }, s.workroomId, s.presentationId);

  for (const [world, review] of [
    ["client", asClient.review],
    ["studio", asStudio.review!],
  ] as const) {
    const [one, two] = review.notes;

    assert.equal(one!.subject, undefined, `${world}: a general point grew a subject`);
    assert.equal(one!.anchor, undefined, `${world}: a general point grew an anchor`);

    assert.equal(two!.subject, Number(identity.value), `${world}: the subject was lost`);
    assert.equal(
      two!.anchor,
      undefined,
      `${world}: item-level feedback was projected as a precise annotation`,
    );
  }

  // And both worlds turn that subject into the same words, from the same helper.
  assert.equal(labelAt(client.items, asClient.review.notes[1]!.subject!), "Primary identity direction");
  assert.equal(labelAt(studio.items, asStudio.review!.notes[1]!.subject!), "Primary identity direction");

  // The whole projection is identical, subject included.
  assert.deepEqual(asStudio.review, asClient.review, "the two worlds read different rounds");
});

/* ----------------------------------------------------------- the labels */

test("a block is always named, and never named as an empty string", () => {
  const items = [
    { position: 0, kind: "note" as const, caption: "Where this came from", body: "Words." },
    { position: 1, kind: "note" as const, caption: "", body: "An opening line to fall back to." },
    { position: 2, kind: "note" as const, caption: null, body: "" },
  ];

  assert.equal(itemLabel(items[0]!), "Where this came from");
  assert.equal(
    itemLabel(items[1]!),
    "An opening line to fall back to.",
    "an empty caption was treated as a caption",
  );
  assert.equal(itemLabel(items[2]!), "A note in this version");

  for (const item of items) {
    assert.notEqual(itemLabel(item).trim(), "", "a block was named with nothing");
  }

  assert.equal(labelAt(items, 9), null, "a position not in this version names nothing");
});

/* --------------------------------------------------- the states it survives */

test("the subject survives closing, superseding and being read as history", async () => {
  await wipe();
  const { s, presentation, client } = await edited();
  const reviewId = (await requestReview(staff, presentation.currentRevisionId!)) as { value: string };

  const identity = itemSubjects(client.items).find(
    (option) => option.label === "Primary identity direction",
  )!;
  const made = await createReviewNote(s.ana, {
    reviewId: reviewId.value,
    body: "This one is the direction.",
    itemPosition: Number(identity.value),
  });
  assert.ok(made.ok);

  const viewer = { contactId: s.ana.contactId, identityId: s.ana.identityId };
  const reads = async (revision?: number) => {
    const asClient = await reviewPanelForViewer(viewer, s.room, s.presentation, revision);
    const asStudio = await reviewPanelForStaff(
      { userId: owner.id },
      s.workroomId,
      s.presentationId,
      revision,
    );
    return { asClient, asStudio };
  };

  const open = await reads();
  assert.equal(open.asClient!.review.notes[0]!.subject, Number(identity.value), "open: no subject");
  assert.equal(open.asStudio.review!.notes[0]!.subject, Number(identity.value));

  // Closed by the studio: read-only, and still says what the point is about.
  assert.ok((await closeReview(staff, reviewId.value)).ok);
  const closed = await reads();
  assert.equal(closed.asClient!.review.status, "closed");
  assert.equal(closed.asClient!.review.notes[0]!.subject, Number(identity.value), "closed: no subject");
  assert.equal(closed.asStudio.review!.notes[0]!.subject, Number(identity.value));

  // Reopened first, because a staff closure keeps its reason: publishing ends
  // the round on the version it replaces and never relabels one somebody
  // already closed. Supersession needs an open round to end.
  assert.ok((await reopenReview(staff, reviewId.value)).ok);

  // Superseded by a newer Revision, and read as history afterwards. The
  // Revision under review keeps its own blocks, so the number still names the
  // same one however many versions have been published since.
  const number = (await findPresentation(s.presentationId))!;
  assert.ok((await publishPresentation(owner, s.presentationId, number.version)).ok);

  const history = await reads(3);
  assert.deepEqual(history.asClient!.review.closedNote, { reason: "superseded", version: 4 });
  assert.equal(
    history.asClient!.review.notes[0]!.subject,
    Number(identity.value),
    "history: no subject",
  );
  assert.equal(history.asStudio.review!.notes[0]!.subject, Number(identity.value));

  // And the label is still resolvable from that Revision's own blocks.
  const frozen = (await revisionForStaff((await findPresentation(s.presentationId))!, 3))!;
  assert.equal(
    labelAt(frozen.items, history.asStudio.review!.notes[0]!.subject!),
    "Primary identity direction",
    "the block a historical point is about lost its name",
  );

  assert.deepEqual(history.asStudio.review, history.asClient!.review, "the worlds diverged");
});
