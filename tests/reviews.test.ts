import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { and, eq, sql } from "drizzle-orm";

import { listActivity } from "../lib/db/activity.ts";
import { listAuditEvents, type AuditActor } from "../lib/db/audit.ts";
import { createClient } from "../lib/db/clients.ts";
import { attachContactToClient, createContact } from "../lib/db/contacts.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
  unpublishPresentation,
  updatePresentation,
} from "../lib/db/presentations.ts";
import { createProject } from "../lib/db/projects.ts";
import {
  closeReview,
  createReviewNote,
  editReviewNote,
  parseAnchor,
  removeReviewNote,
  reopenReview,
  reopenReviewNote,
  replyToReviewNote,
  requestReview,
  resolveReviewNote,
  reviewForRevision,
  reviewNotes,
  withdrawReview,
  type ClientActor,
  type StaffActor,
} from "../lib/db/reviews.ts";
import { createWorkroom, publishWorkroom } from "../lib/db/workrooms.ts";
import {
  clientContacts,
  clientIdentity,
  clientSession,
  clients,
  contacts,
  presentationApprovals,
  presentationItems,
  presentationRevisionItems,
  presentationRevisions,
  presentationReviewNotes,
  presentationReviews,
  presentations,
  projects,
  user,
  workroomActivity,
  workroomFiles,
  workroomInvitations,
  workroomMembers,
  workrooms,
} from "../lib/db/schema.ts";

/**
 * The Review domain: everything `0006` deliberately could not hold.
 *
 * `reviews-schema.test.ts` proves what PostgreSQL refuses. This proves the
 * other half of the split — the rules that need another row, and therefore
 * live in `lib/db/reviews.ts` under the Review row lock: no edit or removal
 * once a reply exists, the round having to be open, the actor having to be the
 * author, and a reopen requiring the Revision to still be the current one.
 *
 * Read `reviews-concurrency.test.ts` beside this. The rules here are stated
 * sequentially; the lock that makes them true under load is proved there, with
 * real simultaneous transactions rather than awaited ones.
 */

const owner: AuditActor = { id: uuidv7(), name: "Test Owner" };
const staff: StaffActor = { side: "studio", userId: owner.id, name: owner.name };

/* ------------------------------------------------------------------ wipe */

const GUARDED = [
  "presentation_review_notes",
  "presentation_reviews",
  "presentation_approvals",
  "presentation_revision_items",
  "presentation_revisions",
];

async function clearAudit(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);
}

export async function wipe(): Promise<void> {
  await clearAudit();
  for (const table of GUARDED) {
    await db().execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`));
  }
  await db().delete(presentationReviewNotes);
  await db().delete(presentationReviews);
  await db().delete(presentationApprovals);
  await db().delete(presentationRevisionItems);
  await db().update(presentations).set({ currentRevisionId: null, status: "draft" });
  await db().delete(presentationRevisions);
  await db().delete(presentationItems);
  await db().delete(presentations);
  for (const table of GUARDED) {
    await db().execute(sql.raw(`ALTER TABLE ${table} ENABLE TRIGGER USER`));
  }
  await db().delete(workroomFiles);
  await db().delete(workroomActivity);
  await db().delete(workroomInvitations);
  await db().delete(workroomMembers);
  await db().delete(clientSession);
  await db().delete(clientIdentity);
  await db().delete(workrooms);
  await db().delete(clientContacts);
  await db().delete(projects);
  await db().delete(contacts);
  await db().delete(clients);
}

before(async () => {
  await wipe();
  await db().delete(user);
  await db()
    .insert(user)
    .values({ id: owner.id, name: owner.name, email: "owner@example.com", role: "owner" });
});

after(async () => {
  await wipe();
  await db().delete(user);
  await closeDb();
});

/* ----------------------------------------------------------------- setup */

export type Stage = {
  workroomId: string;
  presentationId: string;
  title: string;
  revision1: string;
  revision2: string;
  /** Positions 0 and 1 of Revision 2; both are note items, so neither anchors. */
  ana: ClientActor;
  ben: ClientActor;
  /** A member of a different Workroom entirely. */
  outsider: ClientActor;
};

async function person(tag: string, workroomId: string | null): Promise<ClientActor> {
  const contact = await createContact(owner, {
    name: `${tag} Person`,
    email: `${tag.toLowerCase()}@example.com`,
    emailNormalized: `${tag.toLowerCase()}@example.com`,
    phone: null,
    title: null,
    notes: "",
  });
  assert.ok(contact.ok);

  const identityId = uuidv7();
  await db().insert(clientIdentity).values({
    id: identityId,
    name: `${tag} Person`,
    email: `${tag.toLowerCase()}@example.com`,
    emailVerified: true,
    contactId: contact.value,
  });

  if (workroomId) {
    await db().insert(workroomMembers).values({
      id: uuidv7(),
      workroomId,
      contactId: contact.value,
      status: "active",
      grantedBy: owner.id,
    });
  }

  return { side: "client", identityId, contactId: contact.value, name: `${tag} Person` };
}

/** A published Workroom with one Presentation published twice, and two clients. */
export async function stage(tag = "A"): Promise<Stage> {
  const client = await createClient(owner, {
    accountType: "organization",
    name: `${tag} Studio`,
    website: null,
    domain: null,
    status: "active",
    notes: "",
  });
  assert.ok(client.ok);

  const project = await createProject(owner, {
    clientId: client.value,
    name: `${tag} rebrand`,
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(project.ok);

  const made = await createWorkroom(owner, {
    projectId: project.value,
    title: `${tag} rebrand`,
    summary: "A private space for this work.",
  });
  assert.ok(made.ok);
  const workroomId = made.value;
  assert.ok((await publishWorkroom(owner, workroomId, 1)).ok);

  const ana = await person(`${tag}na`, workroomId);
  const ben = await person(`${tag}en`, workroomId);
  assert.ok(
    (
      await attachContactToClient(owner, {
        clientId: client.value,
        contactId: ana.contactId,
        role: "Day to day",
        isPrimary: true,
      })
    ).ok,
  );

  const presentation = await createPresentation(owner, workroomId, {
    title: "Brand Direction",
    intro: "A first direction.",
  });
  assert.ok(presentation.ok);
  const presentationId = presentation.value;

  const v = async () => (await findPresentation(presentationId))!.version;

  assert.ok(
    (await addNoteItem(owner, presentationId, await v(), { caption: "One", body: "First." })).ok,
  );
  assert.ok((await publishPresentation(owner, presentationId, await v())).ok);

  assert.ok(
    (await addNoteItem(owner, presentationId, await v(), { caption: "Two", body: "Second." })).ok,
  );
  assert.ok((await publishPresentation(owner, presentationId, await v())).ok);

  const revisions = await db()
    .select({ id: presentationRevisions.id })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.presentationId, presentationId))
    .orderBy(presentationRevisions.revisionNumber);
  assert.equal(revisions.length, 2);

  return {
    workroomId,
    presentationId,
    title: "Brand Direction",
    revision1: revisions[0]!.id,
    revision2: revisions[1]!.id,
    ana,
    ben,
    outsider: { side: "client", identityId: "", contactId: "", name: "" },
  };
}

/** Requests feedback on the current Revision and returns the round's id. */
export async function round(s: Stage): Promise<string> {
  const made = await requestReview(staff, s.revision2);
  assert.ok(made.ok, made.ok ? "" : made.message);
  return made.value;
}

async function version(reviewId: string): Promise<number> {
  const row = await db()
    .select({ version: presentationReviews.version })
    .from(presentationReviews)
    .where(eq(presentationReviews.id, reviewId));
  return row[0]!.version;
}

async function noteVersion(reviewId: string, number: number): Promise<number> {
  const row = await db()
    .select({ version: presentationReviewNotes.version })
    .from(presentationReviewNotes)
    .where(
      and(
        eq(presentationReviewNotes.presentationReviewId, reviewId),
        eq(presentationReviewNotes.number, number),
      ),
    );
  return row[0]!.version;
}

/** Long enough ago that the correction window has closed. */
async function age(reviewId: string, number: number, minutes: number): Promise<void> {
  await db().execute(sql`
    ALTER TABLE presentation_review_notes DISABLE TRIGGER presentation_review_notes_guard_row
  `);
  await db().execute(sql`
    UPDATE presentation_review_notes
       SET created_at = created_at - ${`${minutes} minutes`}::interval
     WHERE presentation_review_id = ${reviewId} AND number = ${number}
  `);
  await db().execute(sql`
    ALTER TABLE presentation_review_notes ENABLE TRIGGER presentation_review_notes_guard_row
  `);
}

/* --------------------------------------------------------- round lifecycle */

test("a round opens on the current version, and only there", async () => {
  await wipe();
  const s = await stage();

  const historical = await requestReview(staff, s.revision1);
  assert.ok(!historical.ok);
  assert.equal(historical.reason, "blocked");
  assert.match(historical.message, /the version the client is reading/);

  const made = await requestReview(staff, s.revision2);
  assert.ok(made.ok);

  const again = await requestReview(staff, s.revision2);
  assert.ok(!again.ok);
  assert.equal(again.reason, "already_done");

  // One row, whatever anybody presses.
  const [{ rounds }] = await db()
    .select({ rounds: sql<number>`count(*)::int` })
    .from(presentationReviews);
  assert.equal(rounds, 1);
});

test("a withdrawn round is re-requested in place, never duplicated", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await withdrawReview(staff, id, await version(id))).ok);
  assert.equal((await reviewForRevision(s.revision2))!.status, "withdrawn");

  const again = await requestReview(staff, s.revision2);
  assert.ok(again.ok);
  assert.equal(again.value, id, "a second row was created");
  assert.equal((await reviewForRevision(s.revision2))!.status, "open");

  const [{ rounds }] = await db()
    .select({ rounds: sql<number>`count(*)::int` })
    .from(presentationReviews);
  assert.equal(rounds, 1);
});

test("a manual close reopens on the same row; asking again is refused", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await closeReview(staff, id, await version(id))).ok);
  const closed = await reviewForRevision(s.revision2);
  assert.equal(closed!.status, "closed");
  assert.equal(closed!.closedReason, "staff");

  // Requesting again says to reopen rather than quietly doing it.
  const asked = await requestReview(staff, s.revision2);
  assert.ok(!asked.ok);
  assert.match(asked.message, /Reopen it rather than asking again/);

  assert.ok((await reopenReview(staff, id, await version(id))).ok);
  const open = await reviewForRevision(s.revision2);
  assert.equal(open!.status, "open");
  assert.equal(open!.closedReason, null);
  assert.equal(open!.closedByRevisionId, null);
});

test("withdrawal is refused once anything has been said, removed or not", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A thought." })).ok);

  const withdrawn = await withdrawReview(staff, id, await version(id));
  assert.ok(!withdrawn.ok);
  assert.equal(withdrawn.reason, "blocked");
  assert.match(withdrawn.message, /already has feedback/);

  // A removed note is still a note: the ordinal is spent and it was said.
  assert.ok(
    (await removeReviewNote(s.ana, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );
  assert.ok(!(await withdrawReview(staff, id, await version(id))).ok);
});

test("a round cannot be closed, withdrawn or written into twice", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await closeReview(staff, id, await version(id))).ok);

  for (const attempt of [
    () => closeReview(staff, id, 99),
    () => withdrawReview(staff, id, 99),
    () => createReviewNote(s.ana, { reviewId: id, body: "Too late." }),
  ]) {
    const outcome = await attempt();
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, "blocked");
  }
});

test("reopening needs the version to still be the one the client is reading", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await closeReview(staff, id, await version(id))).ok);

  // A third Revision moves the Presentation on.
  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "A third direction.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const reopened = await reopenReview(staff, id, await version(id));
  assert.ok(!reopened.ok);
  assert.equal(reopened.reason, "blocked");
  assert.match(reopened.message, /newer version has been published/);

  // The staff closure it already had is untouched by the publication.
  const row = await reviewForRevision(s.revision2);
  assert.equal(row!.closedReason, "staff");
});

test("an unpublished presentation takes no new round and reopens none", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await closeReview(staff, id, await version(id))).ok);

  const v = (await findPresentation(s.presentationId))!.version;
  assert.ok((await unpublishPresentation(owner, s.presentationId, v)).ok);

  const reopened = await reopenReview(staff, id, await version(id));
  assert.ok(!reopened.ok);
  assert.match(reopened.message, /Publish this presentation/);
});

/* ------------------------------------------------------ publish auto-close */

test("publishing a newer version closes the open round, terminally", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Please change this." })).ok);

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Third.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const row = await reviewForRevision(s.revision2);
  assert.equal(row!.status, "closed");
  assert.equal(row!.closedReason, "superseded");
  assert.ok(row!.closedByRevisionId, "the superseding revision is not recorded");

  // Nothing inside it moved. The client's point is still unresolved, visibly.
  const notes = await reviewNotes(id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.resolvedAt, null);
  assert.equal(notes[0]!.removedAt, null);

  // And it never reopens.
  const reopened = await reopenReview(staff, id, await version(id));
  assert.ok(!reopened.ok);
  assert.match(reopened.message, /closed when a newer version was published/);
});

test("publishing leaves a staff closure and a withdrawal exactly as they were", async () => {
  await wipe();
  const s = await stage();

  const id = await round(s);
  assert.ok((await closeReview(staff, id, await version(id))).ok);

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Third.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const staffClosed = await reviewForRevision(s.revision2);
  assert.equal(staffClosed!.closedReason, "staff", "publishing rewrote a closure reason");
  assert.equal(staffClosed!.closedByRevisionId, null);

  // And a withdrawal on the new current Revision survives the next publish too.
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const second = await requestReview(staff, current);
  assert.ok(second.ok);
  assert.ok((await withdrawReview(staff, second.value, await version(second.value))).ok);

  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Fourth.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const withdrawn = await reviewForRevision(current);
  assert.equal(withdrawn!.status, "withdrawn");
  assert.equal(withdrawn!.closedReason, null);
});

test("publishing is never blocked by an open round, and creates none for the new version", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Third.",
    })).ok,
  );
  const published = await publishPresentation(owner, s.presentationId, await v());
  assert.ok(published.ok, "an open round blocked a publish");

  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  assert.equal(await reviewForRevision(current), null, "a round was created for the new version");
});

/* --------------------------------------------------------- authorization */

test("staff cannot open a feedback item; an active client member can", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  // The type says client, but a cast defeats a type — so the domain refuses a
  // studio actor at runtime. Without that, the row would have stored
  // `author_side = 'client'` with nobody behind it, and the CHECK would have
  // allowed it: it only refuses a root that *admits* to being the studio's.
  const asStaff = await createReviewNote(staff as unknown as ClientActor, {
    reviewId: id,
    body: "The studio's own point.",
  });
  assert.ok(!asStaff.ok);
  assert.equal(asStaff.reason, "blocked");
  assert.match(asStaff.message, /replies to feedback rather than opening it/);

  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Mine." })).ok);
});

test("a client of another workroom reaches nothing, and is told nothing", async () => {
  await wipe();
  const a = await stage("A");
  const b = await stage("B");
  const id = await round(a);

  const outcome = await createReviewNote(b.ana, { reviewId: id, body: "Not mine to write in." });
  assert.ok(!outcome.ok);
  // Concealed: the same answer a round that never existed would give.
  assert.equal(outcome.reason, "not_found");
  assert.match(outcome.message, /no longer exists/);
});

test("being a Contact at the client grants nothing without a membership", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  // Attached to the Client, an identity of their own, and no Workroom member row.
  const stranger = await person("Cara", null);
  assert.ok(
    (
      await attachContactToClient(owner, {
        clientId: (
          await db()
            .select({ id: clients.id })
            .from(clients)
            .limit(1)
        )[0]!.id,
        contactId: stranger.contactId,
        role: "Finance",
        isPrimary: false,
      })
    ).ok,
  );

  const outcome = await createReviewNote(stranger, { reviewId: id, body: "Hello." });
  assert.ok(!outcome.ok);
  assert.equal(outcome.reason, "not_found");
});

test("revoking a membership takes effect on the next call", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "While a member." })).ok);

  await db()
    .update(workroomMembers)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(workroomMembers.contactId, s.ana.contactId));

  const after = await createReviewNote(s.ana, { reviewId: id, body: "After." });
  assert.ok(!after.ok);
  assert.equal(after.reason, "not_found");
});

/* --------------------------------------------------------------- replies */

test("either side may reply, and a reply to a reply is refused cleanly", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);

  const fromStudio = await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "We will." });
  assert.ok(fromStudio.ok);
  assert.equal(fromStudio.value, 2);

  const fromClient = await replyToReviewNote(s.ana, { reviewId: id, parentNumber: 1, body: "Thanks." });
  assert.ok(fromClient.ok);
  assert.equal(fromClient.value, 3);

  // Depth two is structurally impossible; the domain says so first.
  const deeper = await replyToReviewNote(s.ana, { reviewId: id, parentNumber: 2, body: "And…" });
  assert.ok(!deeper.ok);
  assert.equal(deeper.reason, "blocked");
  assert.match(deeper.message, /under the original comment/);

  const notes = await reviewNotes(id);
  assert.deepEqual(
    notes.map((n) => [n.number, n.isRoot, n.parentNumber, n.authorSide]),
    [
      [1, true, null, "client"],
      [2, false, 1, "studio"],
      [3, false, 1, "client"],
    ],
  );
});

test("a reply to a removed comment is refused", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Oops." })).ok);
  assert.ok(
    (await removeReviewNote(s.ana, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );

  const reply = await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "About that…" });
  assert.ok(!reply.ok);
  assert.match(reply.message, /was removed/);
});

/* ----------------------------------------------------------- edit, remove */

test("an author may correct their own words, and nobody else's", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Teh colour." })).ok);

  const byOther = await editReviewNote(s.ben, {
    reviewId: id,
    number: 1,
    body: "Rewritten.",
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!byOther.ok);
  assert.match(byOther.message, /Only the person who wrote it/);

  const byStaff = await editReviewNote(staff, {
    reviewId: id,
    number: 1,
    body: "Rewritten.",
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!byStaff.ok, "the studio edited a client's words");

  assert.ok(
    (await editReviewNote(s.ana, {
      reviewId: id,
      number: 1,
      body: "The colour.",
      expectedVersion: await noteVersion(id, 1),
    })).ok,
  );

  const notes = await reviewNotes(id);
  assert.equal(notes[0]!.body, "The colour.");
  assert.ok(notes[0]!.editedAt, "the correction is not marked");
});

test("no edit and no removal once somebody has replied", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "Noted." })).ok);

  for (const attempt of [
    () =>
      editReviewNote(s.ana, {
        reviewId: id,
        number: 1,
        body: "Actually…",
        expectedVersion: 1,
      }),
    () => removeReviewNote(s.ana, { reviewId: id, number: 1, expectedVersion: 1 }),
  ]) {
    const outcome = await attempt();
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, "blocked");
    assert.match(outcome.message, /Somebody has replied/);
  }

  // The reply itself has no children by design, so its author may still fix it.
  assert.ok(
    (await editReviewNote(staff, {
      reviewId: id,
      number: 2,
      body: "Noted, thank you.",
      expectedVersion: await noteVersion(id, 2),
    })).ok,
  );
});

test("the correction window closes on both correcting and removing", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "An hour ago." })).ok);
  await age(id, 1, 60);

  const edited = await editReviewNote(s.ana, {
    reviewId: id,
    number: 1,
    body: "Second thoughts.",
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!edited.ok);
  assert.match(edited.message, /within 15 minutes/);

  const removed = await removeReviewNote(s.ana, {
    reviewId: id,
    number: 1,
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!removed.ok);
  assert.match(removed.message, /within 15 minutes/);
});

test("a removal is a tombstone, and terminal in every direction", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Pasted the wrong thing." })).ok);
  assert.ok(
    (await removeReviewNote(s.ana, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );

  const notes = await reviewNotes(id);
  assert.equal(notes.length, 1, "the row was deleted");
  assert.equal(notes[0]!.number, 1, "the ordinal was reused");
  assert.equal(notes[0]!.authorName, s.ana.name, "authorship was erased");
  assert.ok(notes[0]!.removedAt);
  // Additive: the body is written beside the tombstone, never over it, which
  // is why the immutability trigger needs no exception. The projection is what
  // hides it — from both surfaces — and that is Implementation C.
  assert.equal(notes[0]!.body, "Pasted the wrong thing.");

  const v = await noteVersion(id, 1);
  for (const attempt of [
    () => editReviewNote(s.ana, { reviewId: id, number: 1, body: "Back again.", expectedVersion: v }),
    () => removeReviewNote(s.ana, { reviewId: id, number: 1, expectedVersion: v }),
    () => resolveReviewNote(staff, { reviewId: id, number: 1, expectedVersion: v }),
    () => reopenReviewNote(staff, { reviewId: id, number: 1, expectedVersion: v }),
    () => replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "About that…" }),
  ]) {
    const outcome = await attempt();
    assert.ok(!outcome.ok);
    assert.equal(outcome.reason, "blocked");
  }
});

/* ------------------------------------------------------ resolve and reopen */

test("the studio may resolve any point; a client only their own", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Ana's point." })).ok);

  const byOtherClient = await resolveReviewNote(s.ben, {
    reviewId: id,
    number: 1,
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!byOtherClient.ok);
  assert.match(byOtherClient.message, /somebody else's comment/);

  assert.ok(
    (await resolveReviewNote(staff, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );

  const [resolved] = await reviewNotes(id);
  assert.equal(resolved!.resolvedBySide, "studio");
  assert.equal(resolved!.resolvedByName, owner.name);
});

test("a client may reopen their own point, including one the studio resolved", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Not happy with this." })).ok);
  assert.ok(
    (await resolveReviewNote(staff, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );

  const byOther = await reopenReviewNote(s.ben, {
    reviewId: id,
    number: 1,
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!byOther.ok);

  assert.ok(
    (await reopenReviewNote(s.ana, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );

  const [note] = await reviewNotes(id);
  assert.equal(note!.resolvedAt, null);
  assert.equal(note!.resolvedBySide, null);
  assert.equal(note!.resolvedByName, null);
});

test("a reply carries no resolution of its own", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "Noted." })).ok);

  const outcome = await resolveReviewNote(staff, {
    reviewId: id,
    number: 2,
    expectedVersion: await noteVersion(id, 2),
  });
  assert.ok(!outcome.ok);
  assert.match(outcome.message, /A reply is not resolved on its own/);
});

test("resolving twice, or reopening what is open, is refused rather than repeated", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "A point." })).ok);

  const reopenedFirst = await reopenReviewNote(staff, {
    reviewId: id,
    number: 1,
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!reopenedFirst.ok);
  assert.equal(reopenedFirst.reason, "already_done");

  assert.ok(
    (await resolveReviewNote(staff, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );
  const twice = await resolveReviewNote(staff, {
    reviewId: id,
    number: 1,
    expectedVersion: await noteVersion(id, 1),
  });
  assert.ok(!twice.ok);
  assert.equal(twice.reason, "already_done");
});

/* --------------------------------------------------------- actor snapshots */

test("history reads correctly after the people in it are gone", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Ana wrote this." })).ok);

  const leaver = uuidv7();
  await db()
    .insert(user)
    .values({ id: leaver, name: "Leaver", email: "leaver@example.com", role: "member" });
  const leaving: StaffActor = { side: "studio", userId: leaver, name: "Leaver" };

  assert.ok((await replyToReviewNote(leaving, { reviewId: id, parentNumber: 1, body: "We hear you." })).ok);
  assert.ok(
    (await resolveReviewNote(leaving, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );

  // `ON DELETE set null` empties both keys. The snapshots are what survive.
  //
  // Audit is cleared first, and that is not a shortcut: `audit_events` is
  // append-only, so its own `ON DELETE set null` is refused by the trigger and
  // a staff member who has ever been audited cannot be deleted at all. That is
  // Build 003's rule working, and it is not what this test is about.
  await clearAudit();
  await db().execute(sql`DELETE FROM "user" WHERE id = ${leaver}`);

  const notes = await reviewNotes(id);
  assert.equal(notes[1]!.authorName, "Leaver");
  assert.equal(notes[1]!.authorSide, "studio");
  assert.equal(notes[0]!.resolvedByName, "Leaver");
  assert.equal(notes[0]!.resolvedBySide, "studio");

  const [keys] = await db()
    .select({
      author: presentationReviewNotes.authorUserId,
      resolver: presentationReviewNotes.resolvedByUserId,
    })
    .from(presentationReviewNotes)
    .where(eq(presentationReviewNotes.number, 2));
  assert.equal(keys!.author, null, "the key survived, so the test proves nothing");
});

/* ------------------------------------------------------------- the anchor */

test("an anchor is accepted only in the shapes its viewer can actually render", async () => {
  const good: [unknown, Parameters<typeof parseAnchor>[1]][] = [
    [{ kind: "point", x: 0, y: 1 }, "image"],
    [{ kind: "region", x: 0.1, y: 0.1, w: 0.3, h: 0.25 }, "image"],
    [{ kind: "time", t: 42.5 }, "video"],
    [{ kind: "time", t: 42.5, t2: 48 }, "video"],
    [{ kind: "time", t: 42.5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, "video"],
    [{ kind: "time", t: 0 }, "audio"],
    [{ kind: "time", t: 1, t2: 2 }, "audio"],
    [null, "image"],
    [null, null],
  ];

  for (const [raw, viewer] of good) {
    const parsed = parseAnchor(raw, viewer);
    assert.ok(parsed.ok, `refused a valid anchor: ${JSON.stringify(raw)}`);
    assert.deepEqual(parsed.value, raw ?? null);
  }

  const bad: [unknown, Parameters<typeof parseAnchor>[1]][] = [
    // Out of the media's own box, which is the only coordinate system there is.
    [{ kind: "point", x: 1.4, y: 0.2 }, "image"],
    [{ kind: "point", x: -0.1, y: 0.2 }, "image"],
    [{ kind: "region", x: 0.1, y: 0.1, w: 2, h: 0.2 }, "image"],
    // A viewport pixel, which is exactly what normalising forbids.
    [{ kind: "point", x: 412, y: 220 }, "image"],
    [{ kind: "point", x: Number.NaN, y: 0.2 }, "image"],
    [{ kind: "point", x: Number.POSITIVE_INFINITY, y: 0.2 }, "image"],
    [{ kind: "point", x: "0.4", y: "0.2" }, "image"],
    [{ kind: "point", x: 0.4 }, "image"],
    [{ kind: "region", x: 0.1, y: 0.1 }, "image"],
    [{ kind: "point", x: 0.4, y: 0.2, note: "extra" }, "image"],
    [{ kind: "sticker", x: 0.4, y: 0.2 }, "image"],
    [{}, "image"],
    [[], "image"],
    ["point", "image"],
    // Temporal on something with no timeline; spatial on something with no frame.
    [{ kind: "time", t: 3 }, "image"],
    [{ kind: "point", x: 0.4, y: 0.2 }, "video"],
    [{ kind: "point", x: 0.4, y: 0.2 }, "audio"],
    [{ kind: "time", t: 3, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }, "audio"],
    [{ kind: "time", t: -3 }, "video"],
    [{ kind: "time", t: 10, t2: 4 }, "video"],
    [{ kind: "time", t: 10, t2: 10 }, "video"],
    [{ kind: "time", t2: 4 }, "video"],
    // No viewer we can draw in, and nothing to draw on.
    [{ kind: "point", x: 0.4, y: 0.2 }, "pdf"],
    [{ kind: "time", t: 1 }, "download"],
    [{ kind: "point", x: 0.4, y: 0.2 }, null],
  ];

  for (const [raw, viewer] of bad) {
    const parsed = parseAnchor(raw, viewer);
    assert.ok(!parsed.ok, `accepted an invalid anchor: ${JSON.stringify(raw)} on ${viewer}`);
    assert.equal(parsed.reason, "invalid");
  }
});

test("an anchor needs a subject, and the subject must be in this version", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  const floating = await createReviewNote(s.ana, {
    reviewId: id,
    body: "Somewhere.",
    anchor: { kind: "point", x: 0.4, y: 0.2 },
  });
  assert.ok(!floating.ok);
  assert.match(floating.message, /which part of the work/);

  // Revision 2 has positions 0 and 1; position 5 is in no version at all.
  const missing = await createReviewNote(s.ana, {
    reviewId: id,
    body: "There.",
    itemPosition: 5,
  });
  assert.ok(!missing.ok);
  assert.equal(missing.reason, "not_found");

  // Both items are written notes, so neither takes a precise anchor…
  const onWords = await createReviewNote(s.ana, {
    reviewId: id,
    body: "Here.",
    itemPosition: 0,
    anchor: { kind: "point", x: 0.4, y: 0.2 },
  });
  assert.ok(!onWords.ok);
  assert.match(onWords.message, /nothing to point at in a written note/);

  // …and item-level feedback on one is fine.
  const plain = await createReviewNote(s.ana, { reviewId: id, body: "About this bit.", itemPosition: 1 });
  assert.ok(plain.ok);
  const notes = await reviewNotes(id);
  assert.equal(notes[0]!.itemPosition, 1);
  assert.equal(notes[0]!.anchor, null);
});

/* ------------------------------------------------------- activity + audit */

test("the client's timeline hears once per round, and never about the rest", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "One." })).ok);
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: "Two." })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: "Noted." })).ok);
  assert.ok(
    (await resolveReviewNote(staff, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );
  assert.ok(
    (await removeReviewNote(s.ana, { reviewId: id, number: 2, expectedVersion: await noteVersion(id, 2) })).ok,
  );
  assert.ok((await closeReview(staff, id, await version(id))).ok);

  const timeline = await listActivity(s.workroomId);
  const reviewKinds = timeline.map((row) => row.kind).filter((kind) => kind.startsWith("review."));
  assert.deepEqual(reviewKinds.sort(), ["review.received", "review.requested"]);
});

test("a withdrawal and a re-request add no second line to the timeline", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);
  assert.ok((await withdrawReview(staff, id, await version(id))).ok);
  assert.ok((await requestReview(staff, s.revision2)).ok);

  const timeline = await listActivity(s.workroomId);
  const requested = timeline.filter((row) => row.kind === "review.requested");
  assert.equal(requested.length, 1);
});

test("audit records every move and never a word of what was written", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  const SECRET = "MARKER-REVIEW-BODY";
  assert.ok((await createReviewNote(s.ana, { reviewId: id, body: SECRET })).ok);
  assert.ok((await replyToReviewNote(staff, { reviewId: id, parentNumber: 1, body: `${SECRET}-reply` })).ok);
  assert.ok(
    (await editReviewNote(staff, {
      reviewId: id,
      number: 2,
      body: `${SECRET}-edited`,
      expectedVersion: await noteVersion(id, 2),
    })).ok,
  );
  assert.ok(
    (await resolveReviewNote(staff, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );
  assert.ok(
    (await reopenReviewNote(staff, { reviewId: id, number: 1, expectedVersion: await noteVersion(id, 1) })).ok,
  );
  assert.ok(
    (await removeReviewNote(staff, { reviewId: id, number: 2, expectedVersion: await noteVersion(id, 2) })).ok,
  );
  assert.ok((await closeReview(staff, id, await version(id))).ok);

  const { rows: events } = await listAuditEvents({ pageSize: 100 });
  const actions = events.map((row) => row.action).filter((a) => a.startsWith("review."));
  for (const expected of [
    "review.requested",
    "review.responded",
    "review.replied",
    "review.edited",
    "review.resolved",
    "review.unresolved",
    "review.removed",
    "review.closed",
  ]) {
    assert.ok(actions.includes(expected), `audit never recorded ${expected}`);
  }

  // Everything, as one string: a body, a fragment or an anchor anywhere in it
  // would be the rule this table exists to keep.
  const whole = JSON.stringify(events);
  assert.ok(!whole.includes(SECRET), "a review body reached the audit trail");

  const removed = events.find((row) => row.action === "review.removed");
  assert.deepEqual(Object.keys(removed!.metadata).sort(), ["note", "workroom_id"]);

  // A client's actions are filed as a client's, never under the staff key.
  const responded = events.find((row) => row.action === "review.responded");
  assert.equal(responded!.actorName, s.ana.name);
});

test("a superseding closure records which version ended it", async () => {
  await wipe();
  const s = await stage();
  const id = await round(s);

  const v = async () => (await findPresentation(s.presentationId))!.version;
  assert.ok(
    (await updatePresentation(owner, s.presentationId, await v(), {
      title: "Brand Direction",
      intro: "Third.",
    })).ok,
  );
  assert.ok((await publishPresentation(owner, s.presentationId, await v())).ok);

  const { rows: events } = await listAuditEvents({ pageSize: 50 });
  const closed = events.find(
    (row) => row.action === "review.closed" && row.entityId === id,
  );
  assert.ok(closed, "the supersession was not audited");
  assert.equal(closed.metadata.reason, "superseded");
  assert.equal(closed.metadata.revision, 3);
});
