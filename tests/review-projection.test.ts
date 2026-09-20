import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { attachContactToClient } from "../lib/db/contacts.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  findPresentation,
  publishPresentation,
  unpublishPresentation,
  updatePresentation,
} from "../lib/db/presentations.ts";
import {
  closeReview,
  createReviewNote,
  editReviewNote,
  removeReviewNote,
  reopenReview,
  reopenReviewNote,
  replyToReviewNote,
  resolveReviewNote,
  reviewForStaff,
  reviewForViewer,
  reviewNotes,
  reviewIdForStaff,
  reviewIdForViewer,
  withdrawReview,
  type StaffActor,
} from "../lib/db/reviews.ts";
import { clients, user, workroomMembers } from "../lib/db/schema.ts";
import { toClientAnchor, toClientReview } from "../lib/workrooms/review-view.ts";
import {
  clearOwner,
  owner,
  person,
  round,
  seedOwner,
  stage,
  staff,
  wipe,
  MARKERS,
  UUID,
} from "./support/review-stage.ts";
import {
  readAnchor,
  readBody,
  readItemPosition,
  readOrdinal,
  readRevisionNumber,
} from "../lib/workrooms/review-input.ts";

/**
 * What a Review surface is allowed to hold.
 *
 * Three questions, and the third is the one that matters most:
 *
 *   **shape**    does the projection say the right thing about each state
 *   **access**   who reaches a round at all, and what a refusal reveals
 *   **leakage**  what the whole serialized result contains, rather than what
 *                the fields it was asked about contain
 *
 * The leak tests seed a marker string into every prohibited place and then
 * assert against `JSON.stringify` of the **complete** projection. Inspecting
 * named fields proves only that the fields somebody thought of are clean; the
 * Build 003 leak was in a redirect body nobody was inspecting.
 */

before(seedOwner);

after(async () => {
  await clearOwner();
  await closeDb();
});

/* ------------------------------------------------------- the projection */

test("an open round projects its notes in the order they were written", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "First point." })).ok);
  assert.ok((await createReviewNote(s.ben, { reviewId: id, body: "Second point." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "We will." })).ok);
  assert.ok((await replyToReviewNote(s.ana, { reviewId: id, parentNumber: 1, body: "Thank you." })).ok);

  const review = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.ok(review);
  assert.equal(review.status, "open");
  assert.equal(review.canWrite, true);
  assert.equal(review.closedNote, undefined);

  assert.deepEqual(
    review.notes.map((n) => [n.n, n.author.side, n.replies.map((r) => r.n)]),
    [
      [1, "client", [3, 4]],
      [2, "client", []],
    ],
  );
  assert.equal(review.notes[0]!.body, "First point.");
  assert.equal(review.notes[0]!.replies[0]!.author.name, owner.name);
  assert.equal(review.notes[0]!.replies[0]!.author.side, "studio");
});

test("an edited note says so; an untouched one does not", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Teh colour." })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Left alone." })).ok);
  assert.ok((await editReviewNote(s.ana, { reviewId: id, number: 1, body: "The colour." })).ok);

  const review = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.equal(review!.notes[0]!.edited, true);
  assert.equal(review!.notes[0]!.body, "The colour.");
  assert.equal(review!.notes[1]!.edited, false);
});

test("a resolved point names who decided it, on either side", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Hers." })).ok);
  assert.ok((await createReviewNote(s.ben, { reviewId: id, body: "His." })).ok);
  assert.ok((await resolveReviewNote(staff, { reviewId: id, number: 1 })).ok);
  assert.ok((await resolveReviewNote(s.ben, { reviewId: id, number: 2 })).ok);

  const review = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.deepEqual(review!.notes[0]!.resolvedBy, { name: owner.name, side: "studio" });
  assert.deepEqual(review!.notes[1]!.resolvedBy, { name: s.ben.name, side: "client" });
  assert.equal(review!.notes[0]!.resolved, true);
});

test("a removed note carries nothing but the fact that somebody wrote one", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  // Anchored and resolved before it is removed, so the projection has every
  // reason to still be carrying something.
  assert.ok(
    (await createReviewNote(s.ana, {
      reviewId: id,
      body: MARKERS.removedRoot,
      itemPosition: 1,
      anchor: { kind: "point", x: 0.42, y: 0.18 },
    })).ok,
  );
  assert.ok((await resolveReviewNote(staff, { reviewId: id, number: 1 })).ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId: id, number: 1 })).ok);

  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A live point." })).ok);
  assert.ok(
    (await replyToReviewNote(staff, { reviewId: id, parentNumber: 2, body: MARKERS.removedReply })).ok,
  );
  assert.ok((await removeReviewNote(staff, { reviewId: id, number: 3 })).ok);

  for (const [who, review] of [
    ["client", await reviewForViewer(s.ana.contactId, s.room, s.presentation)],
    ["studio", await reviewForStaff(s.workroomId, s.presentationId)],
  ] as const) {
    assert.ok(review, who);
    const [tombstone, live] = review.notes;

    assert.equal(tombstone!.removed, true, who);
    assert.equal(tombstone!.body, undefined, `${who} carried a removed body`);
    assert.equal(tombstone!.anchor, undefined, `${who} carried a removed anchor`);
    assert.equal(tombstone!.resolved, false, `${who} carried a removed resolution`);
    assert.equal(tombstone!.resolvedBy, undefined, who);
    assert.equal(tombstone!.edited, false, who);
    // What remains is the shape of the conversation: somebody said something
    // here, at this point in it, and took it back.
    assert.equal(tombstone!.n, 1, who);
    assert.equal(tombstone!.author.name, s.ana.name, who);

    const removedReply = live!.replies[0]!;
    assert.equal(removedReply.removed, true, who);
    assert.equal(removedReply.body, undefined, `${who} carried a removed reply`);
  }
});

test("a closed round says why, and a superseded one says which version ended it", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);
  assert.ok((await closeReview(staff, id)).ok);

  const closed = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.equal(closed!.status, "closed");
  assert.deepEqual(closed!.closedNote, { reason: "closed" });
  assert.equal(closed!.canWrite, false, "a closed round accepted writing");
  assert.equal(closed!.notes.length, 1, "closing hid what was said");

  assert.ok((await reopenReview(staff, id)).ok);
  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Third.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  // Revision 2's round, read as history now that Revision 3 is current.
  const superseded = await reviewForViewer(s.ana.contactId, s.room, s.presentation, 2);
  assert.equal(superseded!.status, "closed");
  assert.deepEqual(superseded!.closedNote, { reason: "superseded", version: 3 });
  assert.equal(superseded!.canWrite, false);
  assert.equal(superseded!.notes.length, 1, "history lost what was said");
});

test("a withdrawn round looks exactly like one nobody ever asked for", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await withdrawReview(staff, id)).ok);

  assert.equal(await reviewForViewer(s.ana.contactId, s.room, s.presentation), null);
  // And Studio sees the same shape: the studio's own administration lives in
  // its surrounding controls, not in a fork of this projection.
  assert.equal(await reviewForStaff(s.workroomId, s.presentationId), null);
});

test("a historical revision reads its own round and never the current one", async () => {
  await wipe();
  const s = await stage();
  const second = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: second, body: "About version two." })).ok);

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Third.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const third = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: third, body: "About version three." })).ok);

  const historical = await reviewForViewer(s.ana.contactId, s.room, s.presentation, 2);
  assert.equal(historical!.notes[0]!.body, "About version two.");
  assert.equal(historical!.canWrite, false);

  const current = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.equal(current!.notes[0]!.body, "About version three.");
  assert.equal(current!.canWrite, true);

  // Version 1 never had one, and says so the same way a wrong version does.
  assert.equal(await reviewForViewer(s.ana.contactId, s.room, s.presentation, 1), null);
});

test("an author still reads correctly after the person is gone", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);

  const leaver = uuidv7();
  await db()
    .insert(user)
    .values({ id: leaver, name: "Leaver", email: "leaver@example.com", role: "member" });
  const leaving: StaffActor = { side: "studio", userId: leaver, name: "Leaver" };
  assert.ok((await replyToReviewNote(leaving, { reviewId: id, parentNumber: 1, body: "Noted." })).ok);
  assert.ok((await resolveReviewNote(leaving, { reviewId: id, number: 1 })).ok);

  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`DELETE FROM "user" WHERE id = ${leaver}`);

  const review = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.deepEqual(review!.notes[0]!.replies[0]!.author, { name: "Leaver", side: "studio" });
  assert.deepEqual(review!.notes[0]!.resolvedBy, { name: "Leaver", side: "studio" });
});

/* ---------------------------------------------------------------- anchors */

test("every anchor the vocabulary allows survives the round trip, by position", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  const cases: [number, unknown][] = [
    [1, { kind: "point", x: 0.42, y: 0.18 }],
    [1, { kind: "region", x: 0.1, y: 0.2, w: 0.3, h: 0.4 }],
    [2, { kind: "time", t: 42.5 }],
    [2, { kind: "time", t: 10, t2: 20 }],
    [2, { kind: "time", t: 5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }],
    [3, { kind: "time", t: 3 }],
    [3, { kind: "time", t: 3, t2: 9 }],
  ];

  for (const [item, anchor] of cases) {
    const made = await createReviewNote(s.ana, {
      reviewId: id,
      body: `About item ${item}.`,
      itemPosition: item,
      anchor,
    });
    assert.ok(made.ok, made.ok ? "" : `${JSON.stringify(anchor)}: ${made.message}`);
  }

  // Item-level on a PDF, and general feedback with no subject at all.
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "The deck.", itemPosition: 4 })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "In general." })).ok);

  const review = await reviewForViewer(s.ana.contactId, s.room, s.presentation);
  assert.deepEqual(
    review!.notes.map((n) => n.anchor),
    [
      { item: 1, kind: "point", x: 0.42, y: 0.18 },
      { item: 1, kind: "region", x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      { item: 2, kind: "time", t: 42.5 },
      { item: 2, kind: "time", t: 10, t2: 20 },
      { item: 2, kind: "time", t: 5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
      { item: 3, kind: "time", t: 3 },
      { item: 3, kind: "time", t: 3, t2: 9 },
      { item: 4 },
      undefined,
    ],
  );
});

test("a stored anchor that should not exist fails closed rather than passing through", () => {
  // These cannot be written through the domain. Anything that reached the
  // column some other way keeps the note's subject — a position, read from a
  // join, and therefore known good — and loses the precision nobody can vouch
  // for. Nothing arbitrary crosses the boundary.
  for (const stored of [
    { kind: "sticker", x: 0.1, y: 0.2 },
    { kind: "point", x: 42, y: 0.2 },
    { kind: "point", x: "0.4", y: "0.2" },
    { kind: "point", x: Number.NaN, y: 0.2 },
    { kind: "point" },
    { kind: "region", x: 0.1, y: 0.2 },
    { kind: "time", t: -1 },
    { kind: "time", t: 10, t2: 4 },
    { kind: "time", t: 1, region: { x: 9, y: 9, w: 9, h: 9 } },
    { note: "arbitrary", secret: "MARKER-SHOULD-NOT-PASS" },
    [],
    "point",
    42,
  ]) {
    const projected = toClientAnchor(2, stored);
    assert.deepEqual(projected, { item: 2 }, `passed through: ${JSON.stringify(stored)}`);
  }

  // And an unanchored note has no anchor at all rather than an empty one.
  assert.equal(toClientAnchor(null, null), undefined);
  assert.equal(toClientAnchor(null, { kind: "point", x: 0.1, y: 0.2 }), undefined);
});

test("the projection orders a round for itself, whatever order the rows arrive in", () => {
  // The reader happens to order by ordinal. The projection does not rely on
  // that, because a future reader with a join or a filter might not — and
  // "somebody's reply appeared above the point it answers" is the kind of
  // defect nobody writes a bug report about.
  const at = new Date("2026-01-01T00:00:00Z");
  const row = (n: number, isRoot: boolean, parentNumber: number | null) => ({
    number: n,
    isRoot,
    parentNumber,
    body: `note ${n}`,
    authorSide: "client" as const,
    authorName: "Ana",
    itemPosition: null,
    anchor: null,
    resolvedAt: null,
    resolvedBySide: null,
    resolvedByName: null,
    editedAt: null,
    removedAt: null,
    createdAt: at,
    version: 1,
  });

  const shuffled = [row(4, false, 2), row(2, true, null), row(3, false, 1), row(1, true, null)];
  const review = toClientReview(
    {
      status: "open",
      closedReason: null,
      requestedAt: at,
      supersededByVersion: null,
      canWrite: true,
    },
    shuffled,
  );

  assert.ok(review);
  assert.deepEqual(
    review.notes.map((n) => [n.n, n.replies.map((r) => r.n)]),
    [
      [1, [3]],
      [2, [4]],
    ],
  );

  // And a withdrawn round is nothing at all, whatever it holds.
  assert.equal(
    toClientReview(
      { status: "withdrawn", closedReason: null, requestedAt: at, supersededByVersion: null, canWrite: true },
      shuffled,
    ),
    null,
  );
});

/* ------------------------------------------------------------ leak tests */

test("nothing prohibited survives serialization, on either surface", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok(
    (await createReviewNote(s.ana, {
      reviewId: id,
      body: MARKERS.removedRoot,
      itemPosition: 1,
      anchor: { kind: "point", x: 0.42, y: 0.18 },
    })).ok,
  );
  assert.ok((await resolveReviewNote(staff, { reviewId: id, number: 1 })).ok);
  assert.ok((await removeReviewNote(s.ana, { reviewId: id, number: 1 })).ok);

  assert.ok(
    (await createReviewNote(s.ana, { reviewId: id, body: "A live point.", itemPosition: 2 })).ok,
  );
  assert.ok(
    (await replyToReviewNote(staff, { reviewId: id, parentNumber: 2, body: MARKERS.removedReply })).ok,
  );
  assert.ok((await removeReviewNote(staff, { reviewId: id, number: 3 })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: id, parentNumber: 2, body: "Still here." })).ok);

  // The markers are really there, underneath. Without this the whole test
  // could pass because nothing was ever seeded — which is how a leak test
  // quietly stops testing anything.
  const raw = JSON.stringify(await reviewNotes(id));
  assert.ok(raw.includes(MARKERS.removedRoot), "the removed root was never seeded");
  assert.ok(raw.includes(MARKERS.removedReply), "the removed reply was never seeded");
  // The domain's own reader is already free of identifiers — it is the
  // projection's job to drop the *words*, and nobody's job to put an id back.
  assert.ok(!UUID.test(raw), "the domain reader started carrying an identifier");
  // And the scan that follows can actually see one.
  assert.ok(UUID.test(`x ${s.workroomId} y`), "the identifier scan matches nothing");

  const surfaces = {
    client: await reviewForViewer(s.ana.contactId, s.room, s.presentation),
    studio: await reviewForStaff(s.workroomId, s.presentationId),
  };

  for (const [who, review] of Object.entries(surfaces)) {
    assert.ok(review, who);
    const whole = JSON.stringify(review);

    for (const [name, marker] of Object.entries(MARKERS)) {
      assert.ok(!whole.includes(marker), `${who} leaked ${name}`);
    }

    // Every identifier in play, by value rather than by the name of a field
    // somebody remembered to check.
    for (const [name, value] of [
      ["review id", id],
      ["workroom id", s.workroomId],
      ["presentation id", s.presentationId],
      ["staff user id", owner.id],
      ["client identity id", s.ana.identityId],
      ["contact id", s.ana.contactId],
    ] as const) {
      assert.ok(!whole.includes(value), `${who} leaked the ${name}`);
    }

    // And the shape of one, in case a future field carries an id nobody named.
    assert.ok(!UUID.test(whole), `${who} carries something shaped like a database id`);

    // Anything read straight from the note rows would bring these with it.
    for (const forbidden of ["isRoot", "parentNumber", "itemPosition", "version", "createdAt"]) {
      assert.ok(!whole.includes(`"${forbidden}"`), `${who} carries the raw field ${forbidden}`);
    }
  }

  // The surfaces agree, which is the point of there being one projection.
  assert.equal(JSON.stringify(surfaces.client), JSON.stringify(surfaces.studio));
});

test("the projection module names every field it emits", () => {
  // A structural guard rather than a value one: a spread of a row into the
  // projection is how the next leak arrives, and it would pass every test
  // above on the day it is written.
  const source = readFileSync("lib/workrooms/review-view.ts", "utf8");
  assert.ok(!/\.\.\.row/.test(source), "a stored row is spread into the projection");
  assert.ok(!/\.\.\.stored/.test(source), "a stored anchor is spread into the projection");
  assert.ok(!/\.\.\.raw/.test(source), "raw input is spread into the projection");
});

/* --------------------------------------------------------- authorization */

test("a client reaches their own round and nothing else", async () => {
  await wipe();
  const a = await stage("A");
  const b = await stage("B");
  const id = await round(a);
  assert.ok((await createReviewNote(a.ana, { reviewId: id, body: "Hers." })).ok);

  // Their own.
  assert.ok(await reviewForViewer(a.ana.contactId, a.room, a.presentation));

  for (const [what, read] of [
    ["another workroom's client", reviewForViewer(b.ana.contactId, a.room, a.presentation)],
    ["their own id against another room", reviewForViewer(a.ana.contactId, b.room, b.presentation)],
    ["a wrong presentation", reviewForViewer(a.ana.contactId, a.room, b.presentation)],
    ["a wrong revision", reviewForViewer(a.ana.contactId, a.room, a.presentation, 9)],
    ["a made-up contact", reviewForViewer(uuidv7(), a.room, a.presentation)],
  ] as const) {
    assert.equal(await read, null, `${what} was not concealed`);
  }
});

test("a revoked member, and a Contact who was never one, both get nothing", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "While a member." })).ok);

  // Attached to the Client, with an identity, and no Workroom membership.
  const stranger = await person("Cara", null, "cara@example.com");
  assert.ok(
    (
      await attachContactToClient(owner, {
        clientId: (await db().select({ id: clients.id }).from(clients).limit(1))[0]!.id,
        contactId: stranger.contactId,
        role: "Finance",
        isPrimary: false,
      })
    ).ok,
  );
  assert.equal(await reviewForViewer(stranger.contactId, s.room, s.presentation), null);
  assert.equal(await reviewIdForViewer(stranger.contactId, s.room, s.presentation), null);

  // And revocation lands on the next read, not when a cookie expires.
  assert.ok(await reviewForViewer(s.ana.contactId, s.room, s.presentation));
  await db()
    .update(workroomMembers)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(workroomMembers.contactId, s.ana.contactId));
  assert.equal(await reviewForViewer(s.ana.contactId, s.room, s.presentation), null);
});

test("an unpublished presentation disappears for the client and stays for the studio", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);

  const v = (await findPresentation(s.presentationId))!.version;
  assert.ok((await unpublishPresentation(owner, s.presentationId, v)).ok);

  assert.equal(await reviewForViewer(s.ana.contactId, s.room, s.presentation), null);
  assert.equal(await reviewIdForViewer(s.ana.contactId, s.room, s.presentation), null);

  // Looking at your own withdrawn work is what Studio is for.
  const studio = await reviewForStaff(s.workroomId, s.presentationId);
  assert.ok(studio);
  assert.equal(studio.notes[0]!.body, "A point.");
});

test("staff cannot reach a presentation through another workroom", async () => {
  await wipe();
  const a = await stage("A");
  const b = await stage("B");
  await round(a);

  assert.ok(await reviewForStaff(a.workroomId, a.presentationId));
  assert.equal(await reviewForStaff(b.workroomId, a.presentationId), null);
  assert.equal(await reviewIdForStaff(b.workroomId, a.presentationId), null);
});

test("a Member does everything an Owner does to a round", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);

  const memberId = uuidv7();
  await db()
    .insert(user)
    .values({ id: memberId, name: "Test Member", email: "member@example.com", role: "member" });
  const member: StaffActor = { side: "studio", userId: memberId, name: "Test Member" };

  // There are no member roles inside a Workroom and none inside a round either:
  // running a client's project is ordinary work. The Owner-only actions in this
  // platform are the ones that reach past a single Workroom, and a round is not
  // one of them.
  assert.ok((await replyToReviewNote(member, { reviewId: id, parentNumber: 1, body: "We will." })).ok);
  assert.ok((await resolveReviewNote(member, { reviewId: id, number: 1 })).ok);
  assert.ok((await reopenReviewNote(member, { reviewId: id, number: 1 })).ok);
  assert.ok((await closeReview(member, id)).ok);
  assert.ok((await reopenReview(member, id)).ok);
  assert.ok((await withdrawReview(member, id)).ok === false, "a round with feedback was withdrawn");
});

/* ------------------------------------------------- the two cookie worlds */

test("neither action layer can authorize the other world", () => {
  const client = code("app/workrooms/(room)/[id]/presentations/reviews.ts");
  const studio = code("app/studio/(app)/workrooms/[id]/presentations/reviews.ts");

  // Structural, and the strongest thing available while no page renders these:
  // a server action with no page to render it has no action id and is not
  // reachable over HTTP at all. When the surfaces arrive, so does the request
  // test — this keeps the wiring honest until then.
  assert.ok(client.includes("client-auth/guard"), "the client actions dropped their guard");
  assert.ok(!client.includes("lib/auth/guard"), "a client action can reach the staff guard");
  assert.ok(!/requireStaff|requireOwner|currentStaff/.test(client), "a client action checks staff");

  assert.ok(studio.includes("lib/auth/guard"), "the studio actions dropped their guard");
  assert.ok(!studio.includes("client-auth/guard"), "a studio action can reach the client guard");
  assert.ok(!/requireViewer|currentViewer/.test(studio), "a studio action checks a client session");

  // Every exported action starts by asking who is calling. A server action is a
  // public endpoint, so one that forgot would be an open door.
  for (const [world, source, guard] of [
    ["client", client, "currentViewer"],
    ["studio", studio, "requireStaff"],
  ] as const) {
    const exported = [...source.matchAll(/export async function (\w+Action)\b/g)].map((m) => m[1]!);
    assert.ok(exported.length >= 6, `${world} exported only ${exported.length} actions`);

    for (const name of exported) {
      const body = source.slice(source.indexOf(`export async function ${name}`));
      const end = body.indexOf("\nexport async function ");
      const scope = end === -1 ? body : body.slice(0, end);
      assert.ok(
        scope.includes(guard) || scope.includes("roundFor"),
        `${world}.${name} never asks who is calling`,
      );
    }
  }
});

/** Prose explains what is refused; only code can do the refusing. */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

test("staff have no way to open a feedback item, and clients none to close a round", () => {
  const client = code("app/workrooms/(room)/[id]/presentations/reviews.ts");
  const studio = code("app/studio/(app)/workrooms/[id]/presentations/reviews.ts");

  // The round is the client's voice; the lifecycle is the studio's. Each is
  // refused in the domain as well, so this is the third line rather than the
  // first — but a missing action is the one a reader notices.
  assert.ok(!studio.includes("createReviewNote"), "a studio action can open a feedback item");

  // Correcting and taking back *are* here, and deliberately. They arrived with
  // Implementation D, when Studio gained a reply worth correcting — before
  // that the studio could not write at all. What keeps them off a client's
  // words is `claimOwnNote` comparing the author key, which is a rule no
  // source scan can check: "staff cannot touch a client's note" is asserted
  // against a running database in review-surface.test.ts instead.
  for (const own of ["editReviewNote", "removeReviewNote"]) {
    assert.ok(studio.includes(own), `the studio cannot ${own} on its own reply`);
  }

  for (const forbidden of ["requestReview", "closeReview", "withdrawReview", "reopenReview("]) {
    assert.ok(!client.includes(forbidden), `a client action can ${forbidden}`);
  }
});

/* ------------------------------------------------------- input validation */

test("a form says what it is allowed to say, and nothing is coerced", () => {
  // Ordinals and revision numbers: one-based, decimal, nothing clever.
  for (const good of ["1", "2", "42", "999999999"]) {
    assert.equal(readOrdinal(good), Number(good), good);
    assert.equal(readRevisionNumber(good), Number(good), good);
  }
  for (const bad of [
    "0",
    "-1",
    "1.0",
    "+1",
    " 1",
    "1 ",
    "1e3",
    "0x10",
    "1abc",
    "",
    "NaN",
    "Infinity",
    "01",
    "9999999999",
    uuidv7(),
    null,
    undefined,
  ]) {
    assert.equal(readOrdinal(bad as never), null, `ordinal accepted ${String(bad)}`);
  }

  // Positions are zero-based, because that is what the Presentation projection
  // has always used — a shared reader would have lost the first item.
  assert.equal(readItemPosition("0"), 0);
  assert.equal(readItemPosition("3"), 3);
  for (const bad of ["-1", "00", "1.5", "", " ", "x", uuidv7(), null]) {
    assert.equal(readItemPosition(bad as never), null, `position accepted ${String(bad)}`);
  }

  // Bodies are trimmed and bounded, never truncated into something shorter
  // than what somebody wrote.
  assert.equal(readBody("  hello  "), "hello");
  assert.equal(readBody(""), null);
  assert.equal(readBody("   "), null);
  assert.equal(readBody("x".repeat(8001)), null);
  assert.equal(readBody("x".repeat(8000))?.length, 8000);
  assert.equal(readBody(null), null);

  // Anchors arrive as JSON and stay unknown: only the domain, which has read
  // the item, can say whether a shape is allowed on it.
  assert.deepEqual(readAnchor('{"kind":"point","x":0.1,"y":0.2}'), {
    kind: "point",
    x: 0.1,
    y: 0.2,
  });
  assert.equal(readAnchor(undefined), undefined);
  assert.equal(readAnchor(""), undefined);
  for (const bad of ["not json", "[]", '"point"', "42", "null", "x".repeat(401)]) {
    assert.equal(readAnchor(bad), null, `anchor accepted ${bad.slice(0, 20)}`);
  }
});
