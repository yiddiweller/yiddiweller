import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq, sql } from "drizzle-orm";

import { type AuditActor } from "../lib/db/audit.ts";
import { createClient } from "../lib/db/clients.ts";
import { attachContactToClient, createContact } from "../lib/db/contacts.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
  updatePresentation,
} from "../lib/db/presentations.ts";
import { createProject } from "../lib/db/projects.ts";
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
 * What migration `0006` makes impossible.
 *
 * Every assertion here is about **PostgreSQL**, not about TypeScript. The Stage
 * C architecture assigns each rule to an enforcer, and the ones that could be
 * structural were made structural precisely so they would still hold against a
 * `psql` prompt, a bad migration, or a domain function nobody has written yet.
 * A rule the application merely believes in is not an invariant, so the
 * application is deliberately not in the call path below: these tests write raw
 * SQL and expect the database to refuse it.
 *
 * What is **not** here, and must not be faked here: no edit or removal once a
 * reply exists, the round having to be open, and the actor having to be the
 * author. Those need another row, they live in the domain under the Review row
 * lock, and `lib/db/reviews.ts` does not exist yet. Half-asserting them with a
 * CHECK would read like protection and be none.
 */

const actor: AuditActor = { id: uuidv7(), name: "Test Owner" };

/** Drizzle wraps driver errors, so what PostgreSQL said is down the chain. */
function chain(error: unknown): string {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    seen.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return seen.join(" | ");
}

/** Assert the database refused, and refused for the stated reason. */
async function refused(run: () => Promise<unknown>, because: RegExp): Promise<void> {
  let raised: unknown;
  try {
    await run();
  } catch (error) {
    raised = error;
  }
  assert.ok(raised, "PostgreSQL accepted what it must refuse");
  assert.match(chain(raised), because);
}

async function clearAudit(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);
}

async function wipe(): Promise<void> {
  await clearAudit();
  // The review and revision tables refuse DELETE by design, so the guards come
  // off for the wipe and go straight back on. **Nothing in the product ever
  // does this**, which is exactly why the DELETE and TRUNCATE tests below run
  // outside this window, against live triggers.
  const guarded = [
    "presentation_review_notes",
    "presentation_reviews",
    "presentation_approvals",
    "presentation_revision_items",
    "presentation_revisions",
  ];
  for (const table of guarded) {
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
  for (const table of guarded) {
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
    .values({ id: actor.id, name: actor.name, email: "owner@example.com", role: "owner" });
});

after(async () => {
  await wipe();
  await db().delete(user);
  await closeDb();
});

/* ------------------------------------------------------------------ setup */

type Stage = {
  workroomId: string;
  /** Revision 1 and its one note item. */
  revision1: string;
  item1: string;
  /** Revision 2 of the same Presentation, with its own item. */
  revision2: string;
  item2: string;
};

/** A Workroom holding one Presentation published twice. */
async function stage(tag: string): Promise<Stage> {
  const client = await createClient(actor, {
    accountType: "organization",
    name: `${tag} Studio`,
    website: null,
    domain: null,
    status: "active",
    notes: "",
  });
  assert.ok(client.ok);

  const contact = await createContact(actor, {
    name: `${tag} Person`,
    email: `${tag.toLowerCase()}@example.com`,
    emailNormalized: `${tag.toLowerCase()}@example.com`,
    phone: null,
    title: null,
    notes: "",
  });
  assert.ok(contact.ok);
  assert.ok(
    (
      await attachContactToClient(actor, {
        clientId: client.value,
        contactId: contact.value,
        role: "Day to day",
        isPrimary: true,
      })
    ).ok,
  );

  const project = await createProject(actor, {
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

  const made = await createWorkroom(actor, {
    projectId: project.value,
    title: `${tag} rebrand`,
    summary: "A private space for this work.",
  });
  assert.ok(made.ok);
  const workroomId = made.value;
  assert.ok((await publishWorkroom(actor, workroomId, 1)).ok);

  const presentation = await createPresentation(actor, workroomId, {
    title: "Brand Direction",
    intro: "A first direction.",
  });
  assert.ok(presentation.ok);
  const id = presentation.value;

  const version = async () => (await findPresentation(id))!.version;

  assert.ok(
    (await addNoteItem(actor, id, await version(), { caption: "Direction", body: "The first." }))
      .ok,
  );
  const first = await publishPresentation(actor, id, await version());
  assert.ok(first.ok);

  assert.ok(
    (
      await updatePresentation(actor, id, await version(), {
        title: "Brand Direction",
        intro: "A second direction.",
      })
    ).ok,
  );
  assert.ok(
    (await addNoteItem(actor, id, await version(), { caption: "More", body: "The second." })).ok,
  );
  const second = await publishPresentation(actor, id, await version());
  assert.ok(second.ok);

  // Scoped to this Presentation: a test may stage two Workrooms, and the
  // cross-tenant cases are worthless if they accidentally share a Revision.
  const mine = await db()
    .select({ id: presentationRevisions.id, number: presentationRevisions.revisionNumber })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.presentationId, id))
    .orderBy(presentationRevisions.revisionNumber);
  assert.equal(mine.length, 2);

  const rows = await db()
    .select({
      id: presentationRevisionItems.id,
      revision: presentationRevisionItems.presentationRevisionId,
    })
    .from(presentationRevisionItems);

  const revision1 = mine[0]!.id;
  const revision2 = mine[1]!.id;
  const item1 = rows.find((r) => r.revision === revision1)!.id;
  const item2 = rows.find((r) => r.revision === revision2)!.id;

  return { workroomId, revision1, item1, revision2, item2 };
}

/** Open a round on a Revision, by raw SQL. Returns its id. */
async function round(s: { workroomId: string }, revisionId: string): Promise<string> {
  const id = uuidv7();
  await db().execute(sql`
    INSERT INTO presentation_reviews (id, workroom_id, presentation_revision_id, status, requested_by)
    VALUES (${id}::uuid, ${s.workroomId}::uuid, ${revisionId}::uuid, 'open', ${actor.id})
  `);
  return id;
}

type NoteInput = {
  review: string;
  workroomId: string;
  revisionId: string;
  number?: number;
  parent?: string | null;
  itemId?: string | null;
  anchor?: string | null;
  side?: "studio" | "client";
  createdAt?: string | null;
  removedAt?: string | null;
};

/** Insert a note by raw SQL, so the database is the only thing deciding. */
async function note(input: NoteInput): Promise<string> {
  const id = uuidv7();
  const parent = input.parent ?? null;
  const side = input.side ?? "client";
  await db().execute(sql`
    INSERT INTO presentation_review_notes (
      id, workroom_id, presentation_review_id, presentation_revision_id, number,
      parent_note_id, is_root, parent_is_root, revision_item_id, anchor, body,
      author_side, author_name, created_at, removed_at
    ) VALUES (
      ${id}::uuid, ${input.workroomId}::uuid, ${input.review}::uuid, ${input.revisionId}::uuid,
      ${input.number ?? Math.floor(Math.random() * 1_000_000) + 1},
      ${parent}::uuid, ${parent === null}, ${parent === null ? null : true},
      ${input.itemId ?? null}::uuid, ${input.anchor ?? null}::jsonb, 'Something to say.',
      ${side}, 'Ana Alder',
      COALESCE(${input.createdAt ?? null}::timestamptz, now()),
      ${input.removedAt ?? null}::timestamptz
    )
  `);
  return id;
}

/* ---------------------------------------------------------- one per Revision */

test("a Revision may hold one Review round and never a second", async () => {
  await wipe();
  const s = await stage("One");
  await round(s, s.revision1);

  await refused(() => round(s, s.revision1), /presentation_reviews_revision_id_key|duplicate key/);

  // A different Revision is a different round, which is the whole point.
  await round(s, s.revision2);
});

test("a Review round cannot be moved to another Revision or Workroom", async () => {
  await wipe();
  const s = await stage("Move");
  const id = await round(s, s.revision1);

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_reviews SET presentation_revision_id = ${s.revision2}::uuid WHERE id = ${id}::uuid`,
      ),
    /belongs to one revision in one workroom/,
  );

  const other = await stage("MoveB");
  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_reviews SET workroom_id = ${other.workroomId}::uuid WHERE id = ${id}::uuid`,
      ),
    /belongs to one revision in one workroom/,
  );
});

/* -------------------------------------------------- exact Revision integrity */

test("a note on Revision 2 cannot point at an item from Revision 1", async () => {
  await wipe();
  const s = await stage("Exact");
  const second = await round(s, s.revision2);

  // Same Workroom, same Presentation, same client — and still refused, because
  // the item belongs to the Revision that was not the one under review.
  await refused(
    () =>
      note({
        review: second,
        workroomId: s.workroomId,
        revisionId: s.revision2,
        itemId: s.item1,
      }),
    /presentation_review_notes_item_fk|violates foreign key/,
  );

  // Its own Revision's item is accepted, so the rule is exact rather than blunt.
  await note({
    review: second,
    workroomId: s.workroomId,
    revisionId: s.revision2,
    itemId: s.item2,
  });
});

test("a note cannot point at another Workroom's item", async () => {
  await wipe();
  const a = await stage("TenantA");
  const b = await stage("TenantB");
  const review = await round(a, a.revision1);

  await refused(
    () => note({ review, workroomId: a.workroomId, revisionId: a.revision1, itemId: b.item1 }),
    /presentation_review_notes_item_fk|violates foreign key/,
  );
});

test("a note cannot claim a Revision its own Review does not name", async () => {
  await wipe();
  const s = await stage("Chain");
  const first = await round(s, s.revision1);

  // The note says Revision 2; its Review says Revision 1. The three-column key
  // is what makes those the same question.
  await refused(
    () => note({ review: first, workroomId: s.workroomId, revisionId: s.revision2 }),
    /presentation_review_notes_review_fk|violates foreign key/,
  );
});

test("a note's Revision cannot be changed after the fact", async () => {
  await wipe();
  const s = await stage("NoteMove");
  const first = await round(s, s.revision1);
  const id = await note({ review: first, workroomId: s.workroomId, revisionId: s.revision1 });

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET presentation_revision_id = ${s.revision2}::uuid WHERE id = ${id}::uuid`,
      ),
    /what a review note is, and what it points at, do not change/,
  );
});

test("general feedback needs no item, which is what MATCH SIMPLE buys", async () => {
  await wipe();
  const s = await stage("General");
  const review = await round(s, s.revision1);

  // No item, no anchor: the composite item FK is skipped rather than violated.
  await note({ review, workroomId: s.workroomId, revisionId: s.revision1, itemId: null });
});

/* ------------------------------------------------------------ thread depth */

test("a reply to a reply cannot be stored", async () => {
  await wipe();
  const s = await stage("Depth");
  const review = await round(s, s.revision1);

  const root = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });
  const reply = await note({
    review,
    workroomId: s.workroomId,
    revisionId: s.revision1,
    parent: root,
    side: "studio",
  });

  await refused(
    () =>
      note({
        review,
        workroomId: s.workroomId,
        revisionId: s.revision1,
        parent: reply,
        side: "client",
      }),
    /presentation_review_notes_parent_is_root_fk|violates foreign key/,
  );
});

test("a reply cannot belong to a different round than its root", async () => {
  await wipe();
  const s = await stage("Rounds");
  const first = await round(s, s.revision1);
  const second = await round(s, s.revision2);
  const root = await note({ review: first, workroomId: s.workroomId, revisionId: s.revision1 });

  await refused(
    () =>
      note({
        review: second,
        workroomId: s.workroomId,
        revisionId: s.revision2,
        parent: root,
        side: "studio",
      }),
    /presentation_review_notes_parent_fk|violates foreign key/,
  );
});

/* ------------------------------------------------------------- authorship */

test("staff cannot open a feedback item, only reply to one", async () => {
  await wipe();
  const s = await stage("Voice");
  const review = await round(s, s.revision1);

  await refused(
    () => note({ review, workroomId: s.workroomId, revisionId: s.revision1, side: "studio" }),
    /presentation_review_notes_root_is_client_check/,
  );

  // As a reply it is exactly what the studio is for.
  const root = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });
  await note({
    review,
    workroomId: s.workroomId,
    revisionId: s.revision1,
    parent: root,
    side: "studio",
  });
});

test("a note's author cannot be rewritten, though its actor key may go null", async () => {
  await wipe();
  const s = await stage("Author");
  const review = await round(s, s.revision1);
  const id = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET author_side = 'studio' WHERE id = ${id}::uuid`,
      ),
    /a review note's author does not change/,
  );
  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET author_name = 'Somebody Else' WHERE id = ${id}::uuid`,
      ),
    /a review note's author does not change/,
  );
});

test("a client note cannot be filed under the staff key, or the reverse", async () => {
  await wipe();
  const s = await stage("Keys");
  const review = await round(s, s.revision1);

  await refused(
    () =>
      db().execute(sql`
        INSERT INTO presentation_review_notes (
          id, workroom_id, presentation_review_id, presentation_revision_id, number,
          is_root, body, author_side, author_user_id, author_name
        ) VALUES (
          ${uuidv7()}::uuid, ${s.workroomId}::uuid, ${review}::uuid, ${s.revision1}::uuid, 1,
          true, 'Mine.', 'client', ${actor.id}, 'Ana Alder'
        )
      `),
    /presentation_review_notes_author_shape_check/,
  );
});

/* ---------------------------------------------------------------- anchors */

test("precision requires a subject", async () => {
  await wipe();
  const s = await stage("Subject");
  const review = await round(s, s.revision1);

  await refused(
    () =>
      note({
        review,
        workroomId: s.workroomId,
        revisionId: s.revision1,
        itemId: null,
        anchor: JSON.stringify({ kind: "point", x: 0.4, y: 0.2 }),
      }),
    /presentation_review_notes_anchor_subject_check/,
  );
});

test("an anchor outside the media's own box is refused", async () => {
  await wipe();
  const s = await stage("Range");
  const review = await round(s, s.revision1);
  const anchored = (anchor: unknown) =>
    note({
      review,
      workroomId: s.workroomId,
      revisionId: s.revision1,
      itemId: s.item1,
      anchor: JSON.stringify(anchor),
    });

  for (const bad of [
    { kind: "point", x: 1.4, y: 0.2 },
    { kind: "point", x: -0.1, y: 0.2 },
    { kind: "region", x: 0.1, y: 0.1, w: 2, h: 0.2 },
    { kind: "time", t: -3 },
    { kind: "time", t: 10, t2: 4 },
    // A viewport pixel, which is the coordinate system this forbids.
    { kind: "point", x: 412, y: 220 },
    { kind: "point", x: "0.4", y: "0.2" },
    { kind: "sticker", x: 0.4, y: 0.2 },
    { kind: "point", x: 0.4 },
    { kind: "region", x: 0.1, y: 0.1 },
    // An object with no `kind` at all: `NULL IN (…)` is NULL, and only the
    // CASE's ELSE keeps the whole expression false rather than unknown.
    {},
  ]) {
    await refused(() => anchored(bad), /presentation_review_notes_anchor_shape_check/);
  }

  // And every shape the product actually stores is accepted.
  for (const good of [
    { kind: "point", x: 0, y: 1 },
    { kind: "region", x: 0.1, y: 0.1, w: 0.3, h: 0.25 },
    { kind: "time", t: 42.5 },
    { kind: "time", t: 42.5, t2: 48 },
    { kind: "time", t: 42.5, region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
  ]) {
    await anchored(good);
  }
});

test("a reply carries no anchor and no resolution of its own", async () => {
  await wipe();
  const s = await stage("ReplyShape");
  const review = await round(s, s.revision1);
  const root = await note({
    review,
    workroomId: s.workroomId,
    revisionId: s.revision1,
    itemId: s.item1,
  });

  await refused(
    () =>
      note({
        review,
        workroomId: s.workroomId,
        revisionId: s.revision1,
        parent: root,
        side: "studio",
        itemId: s.item1,
        anchor: JSON.stringify({ kind: "point", x: 0.4, y: 0.2 }),
      }),
    /presentation_review_notes_reply_shape_check/,
  );

  const reply = await note({
    review,
    workroomId: s.workroomId,
    revisionId: s.revision1,
    parent: root,
    side: "studio",
  });
  await refused(
    () =>
      db().execute(sql`
        UPDATE presentation_review_notes
           SET resolved_at = now(), resolved_by_side = 'studio', resolved_by_name = 'Yiddi Weller'
         WHERE id = ${reply}::uuid
      `),
    /presentation_review_notes_reply_shape_check/,
  );
});

test("resolution without a name snapshot is refused, because a key can go null", async () => {
  await wipe();
  const s = await stage("Resolve");
  const review = await round(s, s.revision1);
  const root = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET resolved_at = now(), resolved_by_side = 'studio' WHERE id = ${root}::uuid`,
      ),
    /presentation_review_notes_resolved_shape_check/,
  );

  await db().execute(sql`
    UPDATE presentation_review_notes
       SET resolved_at = now(), resolved_by_side = 'studio',
           resolved_by_name = 'Yiddi Weller', resolved_by_user_id = ${actor.id}
     WHERE id = ${root}::uuid
  `);
});

/* ----------------------------------------------------- lifecycle and closure */

test("a closed round names exactly one reason, and never both or neither", async () => {
  await wipe();
  const s = await stage("Closure");
  const id = await round(s, s.revision1);
  const set = (fragment: ReturnType<typeof sql>) =>
    db().execute(sql`UPDATE presentation_reviews SET ${fragment} WHERE id = ${id}::uuid`);

  await refused(
    () => set(sql`status = 'closed', closed_at = now()`),
    /presentation_reviews_closure_shape_check/,
  );
  await refused(
    () =>
      set(
        sql`status = 'closed', closed_at = now(), closed_reason = 'staff', closed_by_revision_id = ${s.revision2}::uuid`,
      ),
    /presentation_reviews_closure_shape_check/,
  );
  await refused(
    () => set(sql`status = 'closed', closed_at = now(), closed_reason = 'superseded'`),
    /presentation_reviews_closure_shape_check/,
  );
  await refused(
    () =>
      set(
        sql`status = 'closed', closed_at = now(), closed_reason = 'superseded', closed_by_revision_id = ${s.revision1}::uuid`,
      ),
    /presentation_reviews_superseded_by_other_check/,
  );

  await set(sql`status = 'closed', closed_at = now(), closed_reason = 'staff', closed_by_user_id = ${actor.id}`);
});

test("a round does not move between states it has no business moving between", async () => {
  await wipe();
  const s = await stage("Machine");
  const id = await round(s, s.revision1);

  await db().execute(
    sql`UPDATE presentation_reviews SET status = 'withdrawn', withdrawn_at = now() WHERE id = ${id}::uuid`,
  );
  await refused(
    () =>
      db().execute(sql`
        UPDATE presentation_reviews
           SET status = 'closed', withdrawn_at = NULL, closed_at = now(), closed_reason = 'staff'
         WHERE id = ${id}::uuid
      `),
    /does not move from withdrawn to closed/,
  );

  // Withdrawn to open is the re-request, and it is allowed.
  await db().execute(
    sql`UPDATE presentation_reviews SET status = 'open', withdrawn_at = NULL WHERE id = ${id}::uuid`,
  );
});

test("a staff closure reopens; a supersession never does", async () => {
  await wipe();
  const s = await stage("Reopen");

  const staffClosed = await round(s, s.revision1);
  await db().execute(sql`
    UPDATE presentation_reviews
       SET status = 'closed', closed_at = now(), closed_reason = 'staff', closed_by_user_id = ${actor.id}
     WHERE id = ${staffClosed}::uuid
  `);
  await db().execute(sql`
    UPDATE presentation_reviews
       SET status = 'open', closed_at = NULL, closed_reason = NULL, closed_by_user_id = NULL
     WHERE id = ${staffClosed}::uuid
  `);

  const superseded = await round(s, s.revision2);
  await db().execute(sql`
    UPDATE presentation_reviews
       SET status = 'closed', closed_at = now(), closed_reason = 'superseded',
           closed_by_revision_id = ${s.revision1}::uuid
     WHERE id = ${superseded}::uuid
  `);
  await refused(
    () =>
      db().execute(sql`
        UPDATE presentation_reviews
           SET status = 'open', closed_at = NULL, closed_reason = NULL, closed_by_revision_id = NULL
         WHERE id = ${superseded}::uuid
      `),
    /closed when a newer revision was published: that is permanent/,
  );
});

test("a supersession cannot be relabelled into a staff closure, in one write or two", async () => {
  await wipe();
  const s = await stage("Relabel");
  const id = await round(s, s.revision2);
  await db().execute(sql`
    UPDATE presentation_reviews
       SET status = 'closed', closed_at = now(), closed_reason = 'superseded',
           closed_by_revision_id = ${s.revision1}::uuid
     WHERE id = ${id}::uuid
  `);

  // Step one of the two-write route: rewrite the reason while staying closed.
  await refused(
    () =>
      db().execute(sql`
        UPDATE presentation_reviews
           SET closed_reason = 'staff', closed_by_revision_id = NULL, closed_by_user_id = ${actor.id}
         WHERE id = ${id}::uuid
      `),
    /closed when a newer revision was published: that is permanent/,
  );

  // And the superseding Revision itself is not editable away.
  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_reviews SET closed_by_revision_id = NULL WHERE id = ${id}::uuid`,
      ),
    /closed when a newer revision was published: that is permanent/,
  );
  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_reviews SET closed_at = now() + interval '1 day' WHERE id = ${id}::uuid`,
      ),
    /closed when a newer revision was published: that is permanent/,
  );
});

test("a staff closure survives the staff member leaving", async () => {
  await wipe();
  const s = await stage("Leaver");
  const id = await round(s, s.revision1);

  const leaver = uuidv7();
  await db().insert(user).values({ id: leaver, name: "Leaver", email: "leaver@example.com", role: "member" });
  await db().execute(sql`
    UPDATE presentation_reviews
       SET status = 'closed', closed_at = now(), closed_reason = 'staff', closed_by_user_id = ${leaver}
     WHERE id = ${id}::uuid
  `);

  // `ON DELETE set null` fires, and the closure shape must survive it — which
  // is the whole reason `closed_reason` exists rather than being inferred.
  await db().execute(sql`DELETE FROM "user" WHERE id = ${leaver}`);

  const [row] = await db()
    .select({ status: presentationReviews.status, reason: presentationReviews.closedReason })
    .from(presentationReviews);
  assert.equal(row?.status, "closed");
  assert.equal(row?.reason, "staff");
});

/* ---------------------------------------------------- removal and the window */

test("a removal is permanent and cannot be undone", async () => {
  await wipe();
  const s = await stage("Tombstone");
  const review = await round(s, s.revision1);
  const id = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });

  await db().execute(
    sql`UPDATE presentation_review_notes SET removed_at = now() WHERE id = ${id}::uuid`,
  );

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET removed_at = NULL WHERE id = ${id}::uuid`,
      ),
    /a removal is permanent/,
  );
  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET removed_at = now() - interval '1 minute' WHERE id = ${id}::uuid`,
      ),
    /a removal is permanent/,
  );
});

test("a removed note is not edited and takes no new resolution state", async () => {
  await wipe();
  const s = await stage("Terminal");
  const review = await round(s, s.revision1);
  const id = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });
  await db().execute(
    sql`UPDATE presentation_review_notes SET removed_at = now() WHERE id = ${id}::uuid`,
  );

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET body = 'Rewritten.' WHERE id = ${id}::uuid`,
      ),
    /a removed review note is not edited/,
  );
  await refused(
    () =>
      db().execute(sql`
        UPDATE presentation_review_notes
           SET resolved_at = now(), resolved_by_side = 'studio', resolved_by_name = 'Yiddi Weller'
         WHERE id = ${id}::uuid
      `),
    /a removed review note takes no new resolution state/,
  );
});

test("the correction window closes, and so does the removal window", async () => {
  await wipe();
  const s = await stage("Window");
  const review = await round(s, s.revision1);

  const id = uuidv7();
  await db().execute(sql`
    INSERT INTO presentation_review_notes (
      id, workroom_id, presentation_review_id, presentation_revision_id, number,
      is_root, body, author_side, author_name, created_at
    ) VALUES (
      ${id}::uuid, ${s.workroomId}::uuid, ${review}::uuid, ${s.revision1}::uuid, 1,
      true, 'Written an hour ago.', 'client', 'Ana Alder', now() - interval '1 hour'
    )
  `);

  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET body = 'Second thoughts.' WHERE id = ${id}::uuid`,
      ),
    /only be corrected within 15 minutes/,
  );
  await refused(
    () =>
      db().execute(
        sql`UPDATE presentation_review_notes SET removed_at = now() WHERE id = ${id}::uuid`,
      ),
    /only be removed within 15 minutes/,
  );

  // Something written just now is still the author's to fix.
  const fresh = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });
  await db().execute(
    sql`UPDATE presentation_review_notes SET body = 'Corrected.', edited_at = now() WHERE id = ${fresh}::uuid`,
  );
});

/* -------------------------------------------------- history is not deletable */

test("a Review round cannot be deleted or truncated", async () => {
  await wipe();
  const s = await stage("Undeletable");
  const id = await round(s, s.revision1);

  await refused(
    () => db().execute(sql`DELETE FROM presentation_reviews WHERE id = ${id}::uuid`),
    /lifecycle record: DELETE is not permitted/,
  );
  await refused(
    () => db().execute(sql`TRUNCATE presentation_reviews CASCADE`),
    /lifecycle record: TRUNCATE is not permitted/,
  );

  // Which is what makes "one round per Revision, ever" mean what it says: the
  // Revision cannot be freed up for a second round by removing the first.
  await refused(() => round(s, s.revision1), /presentation_reviews_revision_id_key|duplicate key/);
});

test("a review note cannot be deleted or truncated", async () => {
  await wipe();
  const s = await stage("NoteHistory");
  const review = await round(s, s.revision1);
  const id = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });

  await refused(
    () => db().execute(sql`DELETE FROM presentation_review_notes WHERE id = ${id}::uuid`),
    /business history: DELETE is not permitted/,
  );
  await refused(
    () => db().execute(sql`TRUNCATE presentation_review_notes`),
    /business history: TRUNCATE is not permitted/,
  );
});

test("ordinals within a round are unique", async () => {
  await wipe();
  const s = await stage("Ordinals");
  const review = await round(s, s.revision1);
  await note({ review, workroomId: s.workroomId, revisionId: s.revision1, number: 1 });

  await refused(
    () => note({ review, workroomId: s.workroomId, revisionId: s.revision1, number: 1 }),
    /presentation_review_notes_number_key|duplicate key/,
  );

  await note({ review, workroomId: s.workroomId, revisionId: s.revision1, number: 2 });
});

test("a note's version rises on update, so optimistic concurrency has something to compare", async () => {
  await wipe();
  const s = await stage("Version");
  const review = await round(s, s.revision1);
  const id = await note({ review, workroomId: s.workroomId, revisionId: s.revision1 });

  await db().execute(
    sql`UPDATE presentation_review_notes SET body = 'Corrected.' WHERE id = ${id}::uuid`,
  );
  const [row] = await db()
    .select({ version: presentationReviewNotes.version })
    .from(presentationReviewNotes);
  assert.equal(row?.version, 2);
});
