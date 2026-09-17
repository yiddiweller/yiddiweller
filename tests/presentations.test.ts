import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { sql } from "drizzle-orm";

import { listActivity } from "../lib/db/activity.ts";
import { listAuditEvents, type AuditActor } from "../lib/db/audit.ts";
import { createClient } from "../lib/db/clients.ts";
import { attachContactToClient, createContact } from "../lib/db/contacts.ts";
import { archiveFile, beginUpload, finalizeUpload, findFile, setFileVisibility } from "../lib/db/files.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  addFileItem,
  addNoteItem,
  archivePresentation,
  contentHash,
  createPresentation,
  filesToShareOnPublish,
  findPresentation,
  listDraftItems,
  listDraftRows,
  listRevisions,
  moveItem,
  presentationForViewer,
  presentationsForViewer,
  presentationsInWorkroom,
  publishPresentation,
  removeItem,
  revisionForStaff,
  unpublishPresentation,
  updateItem,
  updatePresentation,
} from "../lib/db/presentations.ts";
import { createProject } from "../lib/db/projects.ts";
import {
  acceptWorkroomInvitation,
  createWorkroom,
  findWorkroom,
  inviteToWorkroom,
  publishWorkroom,
} from "../lib/db/workrooms.ts";
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
import { resetStorage } from "../lib/storage/client.ts";
import { permanentKey } from "../lib/storage/keys.ts";
import { toPresentationContent } from "../lib/workrooms/presentation-view.ts";
import { S3Stub, useStub } from "./support/s3-stub.ts";

/**
 * Presentations, at the layer that decides them.
 *
 * Most of what is proved here is PostgreSQL rather than TypeScript: a Revision
 * that refuses to be edited, a revision number two concurrent publishes cannot
 * both take, a Presentation that cannot name another Presentation's Revision.
 * Where a check exists in both the application and the database, the database
 * one is tested directly — an invariant the application merely believes in is
 * not an invariant.
 */

const actor: AuditActor = { id: uuidv7(), name: "Test Owner" };
const stub = new S3Stub();

/** Seeded into every internal field. None may reach a client projection. */
const MARKERS = ["MARKER-CLIENT-NOTE", "MARKER-PROJECT-NOTE", "MARKER-ORIGINAL-FILENAME"];

/** Drizzle wraps driver errors, so what PostgreSQL actually said is down the
 * chain. Asserting on the wrapper would pass for any failed query at all. */
function chain(error: unknown): string {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    seen.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return seen.join(" | ");
}

async function clearAudit(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);
}

async function wipe(): Promise<void> {
  await clearAudit();
  // Immutable tables refuse DELETE, so the triggers come off for the wipe and
  // go straight back on. Nothing in the product ever does this.
  for (const table of ["presentation_approvals", "presentation_revision_items", "presentation_revisions"]) {
    await db().execute(sql.raw(`ALTER TABLE ${table} DISABLE TRIGGER USER`));
  }
  await db().delete(presentationReviews);
  await db().delete(presentationApprovals);
  await db().delete(presentationRevisionItems);
  await db().update(presentations).set({ currentRevisionId: null, status: "draft" });
  await db().delete(presentationRevisions);
  await db().delete(presentationItems);
  await db().delete(presentations);
  for (const table of ["presentation_approvals", "presentation_revision_items", "presentation_revisions"]) {
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
  stub.objects.clear();
  stub.seen.length = 0;
}

before(async () => {
  const endpoint = await stub.start();
  useStub(endpoint);
  resetStorage();

  await wipe();
  await db().delete(user);
  await db()
    .insert(user)
    .values({ id: actor.id, name: actor.name, email: "owner@example.com", role: "owner" });
});

beforeEach(wipe);

after(async () => {
  await wipe();
  await db().delete(user);
  await closeDb();
  await stub.stop();
});

/* ------------------------------------------------------------------ setup */

type Room = { clientId: string; contactId: string; workroomId: string; publicId: string };

async function room(tag: string, name: string, person: string, email: string): Promise<Room> {
  const client = await createClient(actor, {
    accountType: "organization",
    name,
    website: null,
    domain: null,
    status: "active",
    notes: `MARKER-CLIENT-NOTE-${tag}`,
  });
  assert.ok(client.ok);

  const contact = await createContact(actor, {
    name: person,
    email,
    emailNormalized: email,
    phone: null,
    title: "Director",
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
    name: `${name} rebrand`,
    status: "active",
    description: "",
    notes: `MARKER-PROJECT-NOTE-${tag}`,
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(project.ok);

  const made = await createWorkroom(actor, {
    projectId: project.value,
    title: `${name} rebrand`,
    summary: "A private space for this work.",
  });
  assert.ok(made.ok);

  const draft = await findWorkroom(made.value);
  assert.ok((await publishWorkroom(actor, made.value, draft!.version)).ok);

  const issued = await inviteToWorkroom(actor, { workroomId: made.value, contactId: contact.value });
  assert.ok(issued.ok);
  assert.ok((await acceptWorkroomInvitation({ token: issued.value.token, name: person })).ok);

  return {
    clientId: client.value,
    contactId: contact.value,
    workroomId: made.value,
    publicId: draft!.publicId,
  };
}

async function upload(r: Room, displayName: string, contentType = "image/png"): Promise<string> {
  const bytes = Buffer.from(`bytes for ${displayName}`);
  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: `MARKER-ORIGINAL-FILENAME-${displayName}`,
    contentType,
    declaredSize: bytes.length,
    supersedesFileId: null,
    displayName,
  });
  assert.ok(ticket.ok, ticket.ok ? "" : ticket.message);

  stub.place(ticket.value.key, bytes);
  stub.place(`${permanentKey(r.workroomId, ticket.value.fileId)}/preview`, "tiny");

  const stored = await finalizeUpload(actor, ticket.value.fileId, {
    declaredSize: bytes.length,
    previewUploaded: true,
  });
  assert.ok(stored.ok, stored.ok ? "" : stored.message);
  return ticket.value.fileId;
}

/** A Presentation with one file and one note, still a draft. */
async function drafted(r: Room, title = "Brand direction") {
  const made = await createPresentation(actor, r.workroomId, {
    title,
    intro: "Here is the direction we developed.",
  });
  assert.ok(made.ok);
  const id = made.value;

  const fileId = await upload(r, "Concept board.png");

  let version = (await findPresentation(id))!.version;
  assert.ok((await addNoteItem(actor, id, version, { caption: "Where this came from", body: "Two weeks of looking." })).ok);

  version = (await findPresentation(id))!.version;
  assert.ok((await addFileItem(actor, id, version, fileId, "Primary identity direction")).ok);

  return { id, fileId };
}

/* --------------------------------------------------------------- the draft */

test("a draft is invisible to the client, and to the client preview", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  await drafted(r);

  assert.deepEqual(await presentationsForViewer(r.contactId, r.publicId), []);
  assert.deepEqual(await presentationsInWorkroom(r.workroomId), []);

  // Not merely absent from the list: unreachable by its own address.
  const one = (await db().select().from(presentations).limit(1))[0]!;
  assert.equal(await presentationForViewer(r.contactId, r.publicId, one.publicId), null);
});

test("two item kinds, and each refuses the other's shape", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);

  const rows = await listDraftRows(id);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.kind),
    ["note", "file"],
  );

  // A note with no words is refused before it reaches the CHECK.
  let version = (await findPresentation(id))!.version;
  const empty = await addNoteItem(actor, id, version, { caption: "Heading", body: "   " });
  assert.equal(empty.ok, false);

  // And the database refuses the same shape directly.
  const workroomId = rows[0]!.workroomId;
  await assert.rejects(
    () => db().insert(presentationItems).values({
      id: uuidv7(),
      workroomId,
      presentationId: id,
      kind: "note",
      fileId: null,
      caption: null,
      body: null,
      position: 9,
    }),
    (error: Error) => /presentation_items_shape_check/.test(chain(error)),
  );

  version = (await findPresentation(id))!.version;
  assert.equal(version > 0, true);
});

test("only a ready, unarchived file from this workroom may be presented", async () => {
  const a = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const b = await room("b", "Birch Group", "Ben Birch", "ben@birch.test");

  const made = await createPresentation(actor, a.workroomId, { title: "Direction", intro: "" });
  assert.ok(made.ok);

  // Another Workroom's file.
  const theirs = await upload(b, "Their board.png");
  let version = (await findPresentation(made.value))!.version;
  const crossed = await addFileItem(actor, made.value, version, theirs, "");
  assert.equal(crossed.ok, false);
  assert.equal(crossed.ok === false && crossed.reason, "not_found");

  // A pending upload, which has no bytes and would block the cleanup sweep.
  const ticket = await beginUpload(actor, {
    workroomId: a.workroomId,
    filename: "half.png",
    contentType: "image/png",
    declaredSize: 10,
    supersedesFileId: null,
  });
  assert.ok(ticket.ok);
  version = (await findPresentation(made.value))!.version;
  const pending = await addFileItem(actor, made.value, version, ticket.value.fileId, "");
  assert.equal(pending.ok, false);
  assert.equal(pending.ok === false && pending.reason, "blocked");

  // An archived file.
  const archived = await upload(a, "Old board.png");
  assert.ok((await archiveFile(actor, archived, (await findFile(archived))!.version)).ok);
  version = (await findPresentation(made.value))!.version;
  const gone = await addFileItem(actor, made.value, version, archived, "");
  assert.equal(gone.ok, false);
});

test("the database refuses a cross-workroom presentation item outright", async () => {
  const a = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const b = await room("b", "Birch Group", "Ben Birch", "ben@birch.test");

  const made = await createPresentation(actor, a.workroomId, { title: "Direction", intro: "" });
  assert.ok(made.ok);
  const theirs = await upload(b, "Their board.png");

  // Not "should not" — cannot. The composite key names the Workroom on both
  // sides, so a row claiming one Workroom's presentation and another's file
  // has nowhere to point.
  await assert.rejects(
    () => db().insert(presentationItems).values({
      id: uuidv7(),
      workroomId: a.workroomId,
      presentationId: made.value,
      kind: "file",
      fileId: theirs,
      caption: null,
      body: null,
      position: 0,
    }),
    (error: Error) => /presentation_items_file_fk/.test(chain(error)),
  );
});

/* ------------------------------------------------------------- publishing */

test("publishing freezes a revision, shares its files, and tells everybody once", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);

  assert.equal((await findFile(fileId))!.visibility, "internal");
  assert.deepEqual(
    (await filesToShareOnPublish(id)).map((file) => file.displayName),
    ["Concept board.png"],
  );

  const version = (await findPresentation(id))!.version;
  const done = await publishPresentation(actor, id, version);
  assert.ok(done.ok, done.ok ? "" : done.message);
  assert.equal(done.value.revision, 1);
  assert.equal(done.value.sharedFiles, 1);

  // Publishing shares. One predicate governs what a client may see, and this
  // is what keeps it true inside a Revision opened years later.
  assert.equal((await findFile(fileId))!.visibility, "shared");

  const after = await findPresentation(id);
  assert.equal(after!.status, "published");
  assert.ok(after!.currentRevisionId);
  assert.ok(after!.publishedAt);

  const revisions = await listRevisions(id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.revisionNumber, 1);
  assert.equal(revisions[0]!.publishedByName, "Test Owner");
  assert.equal(revisions[0]!.contentHash.length, 64);

  const items = await db()
    .select()
    .from(presentationRevisionItems)
    .where(sql`presentation_revision_id = ${revisions[0]!.id}`);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.position).sort(), [0, 1]);

  const kinds = (await listActivity(r.workroomId)).map((event) => event.kind);
  assert.equal(kinds.filter((k) => k === "presentation.published").length, 1);
  assert.equal(kinds.filter((k) => k === "presentation.revised").length, 0);
  assert.equal(kinds.filter((k) => k === "file.shared").length, 1);

  const actions = (await listAuditEvents({ pageSize: 100 })).rows.map((row) => row.action);
  assert.ok(actions.includes("presentation.published"));
  assert.ok(actions.includes("file.shared"));
});

test("a second publish is a revision, not a new deliverable", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);

  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const second = await publishPresentation(actor, id, (await findPresentation(id))!.version);
  assert.ok(second.ok);
  assert.equal(second.value.revision, 2);
  // Nothing new was shared: the file already was.
  assert.equal(second.value.sharedFiles, 0);

  const kinds = (await listActivity(r.workroomId)).map((event) => event.kind);
  assert.equal(kinds.filter((k) => k === "presentation.published").length, 1);
  assert.equal(kinds.filter((k) => k === "presentation.revised").length, 1);
});

test("publishing is refused where it would mean nothing", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");

  const made = await createPresentation(actor, r.workroomId, { title: "Empty", intro: "" });
  assert.ok(made.ok);

  const empty = await publishPresentation(actor, made.value, (await findPresentation(made.value))!.version);
  assert.equal(empty.ok, false);
  assert.equal(empty.ok === false && empty.reason, "blocked");
  assert.equal((await listRevisions(made.value)).length, 0);
});

/* ------------------------------------------- draft and published diverge */

test("editing after publication changes the draft and not the client's page", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);

  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const before = await presentationForViewer(r.contactId, r.publicId, (await findPresentation(id))!.publicId);
  assert.ok(before);
  assert.equal(before.title, "Brand direction");
  assert.equal(before.items.length, 2);

  // Rewrite the draft thoroughly.
  assert.ok(
    (await updatePresentation(actor, id, (await findPresentation(id))!.version, {
      title: "Something else entirely",
      intro: "Rewritten.",
    })).ok,
  );
  const rows = await listDraftRows(id);
  assert.ok((await removeItem(actor, id, (await findPresentation(id))!.version, rows[0]!.id)).ok);

  const after = await presentationForViewer(r.contactId, r.publicId, (await findPresentation(id))!.publicId);
  assert.ok(after);
  assert.equal(after.title, "Brand direction", "the client's page followed the draft");
  assert.equal(after.items.length, 2, "the client's page followed the draft");
  assert.equal(after.revision, 1);

  // And the draft really did change — otherwise this test proves nothing.
  assert.equal((await findPresentation(id))!.title, "Something else entirely");
  assert.equal((await listDraftRows(id)).length, 1);
});

test("a client may revisit every published version, and the latest is current", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  const publicId = (await findPresentation(id))!.publicId;

  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  assert.ok(
    (await updatePresentation(actor, id, (await findPresentation(id))!.version, {
      title: "Brand direction",
      intro: "Second pass.",
    })).ok,
  );
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const current = await presentationForViewer(r.contactId, r.publicId, publicId);
  assert.ok(current);
  assert.equal(current.revision, 2);
  assert.equal(current.intro, "Second pass.");
  assert.equal(current.revisions.length, 2);
  assert.deepEqual(
    current.revisions.map((entry) => [entry.number, entry.current]),
    [
      [2, true],
      [1, false],
    ],
  );

  const old = await presentationForViewer(r.contactId, r.publicId, publicId, 1);
  assert.ok(old);
  assert.equal(old.revision, 1);
  assert.equal(old.intro, "Here is the direction we developed.", "history followed the draft");

  // A version that was never published is not a version.
  assert.equal(await presentationForViewer(r.contactId, r.publicId, publicId, 3), null);
  assert.equal(await presentationForViewer(r.contactId, r.publicId, publicId, 99), null);
});

/* ----------------------------------------------------------- immutability */

test("a published revision refuses every kind of rewriting, in the database", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const revision = (await listRevisions(id))[0]!;

  await assert.rejects(
    () => db().execute(sql`UPDATE presentation_revisions SET content_hash = repeat('0', 64) WHERE id = ${revision.id}`),
    (error: Error) => /immutable/i.test(chain(error)),
  );
  await assert.rejects(
    () => db().execute(sql`DELETE FROM presentation_revisions WHERE id = ${revision.id}`),
    (error: Error) => /immutable/i.test(chain(error)),
  );
  await assert.rejects(
    () => db().execute(sql`TRUNCATE presentation_revisions CASCADE`),
    (error: Error) => /immutable/i.test(chain(error)),
  );

  await assert.rejects(
    () => db().execute(sql`UPDATE presentation_revision_items SET caption = 'edited' WHERE presentation_revision_id = ${revision.id}`),
    (error: Error) => /immutable/i.test(chain(error)),
  );
  await assert.rejects(
    () => db().execute(sql`DELETE FROM presentation_revision_items WHERE presentation_revision_id = ${revision.id}`),
    (error: Error) => /immutable/i.test(chain(error)),
  );
  await assert.rejects(
    () => db().execute(sql`TRUNCATE presentation_revision_items CASCADE`),
    (error: Error) => /immutable/i.test(chain(error)),
  );
});

test("a revision number cannot be taken twice", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const presentation = (await findPresentation(id))!;

  await assert.rejects(
    () => db().insert(presentationRevisions).values({
      id: uuidv7(),
      workroomId: presentation.workroomId,
      presentationId: id,
      revisionNumber: 1,
      snapshot: { title: "", intro: "", items: [] },
      contentHash: "0".repeat(64),
      publishedByName: "Nobody",
    }),
    (error: Error) => /presentation_revisions_number_idx/.test(chain(error)),
  );
});

/* ------------------------------------------------- the 0005 integrity gaps */

test("a presentation cannot point at another presentation's revision", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const one = await drafted(r, "One");
  const two = await drafted(r, "Two");

  assert.ok((await publishPresentation(actor, one.id, (await findPresentation(one.id))!.version)).ok);
  const theirs = (await listRevisions(one.id))[0]!;

  // The composite key names the Presentation on both sides, so this has
  // nowhere to point. Before 0005 the column carried no foreign key at all.
  await assert.rejects(
    () => db().execute(sql`UPDATE presentations SET current_revision_id = ${theirs.id} WHERE id = ${two.id}`),
    (error: Error) => /presentations_current_revision_fk/.test(chain(error)),
  );

  // And a revision that does not exist is refused for the same reason.
  await assert.rejects(
    () => db().execute(sql`UPDATE presentations SET current_revision_id = ${uuidv7()} WHERE id = ${two.id}`),
    (error: Error) => /presentations_current_revision_fk/.test(chain(error)),
  );
});

test("published means there is something to show", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);

  await assert.rejects(
    () => db().execute(sql`UPDATE presentations SET status = 'published' WHERE id = ${id}`),
    (error: Error) => /presentations_published_shape_check/.test(chain(error)),
  );

  // The inverse is deliberately not required: withdrawing keeps the history.
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);
  assert.ok((await unpublishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const after = await findPresentation(id);
  assert.equal(after!.status, "unpublished");
  assert.ok(after!.currentRevisionId, "withdrawing erased which revision it had reached");
  assert.ok(after!.publishedAt);
});

test("a revision item proves what name the client read, or is refused", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const presentation = (await findPresentation(id))!;
  const revision = (await listRevisions(id))[0]!;

  // A file item with no snapshotted name.
  await assert.rejects(
    () => db().insert(presentationRevisionItems).values({
      id: uuidv7(),
      workroomId: presentation.workroomId,
      presentationRevisionId: revision.id,
      position: 50,
      kind: "file",
      fileId,
      displayNameSnapshot: null,
      caption: null,
      body: null,
    }),
    (error: Error) => /presentation_revision_items_shape_check/.test(chain(error)),
  );

  // A note carrying one, which would be meaningless.
  await assert.rejects(
    () => db().insert(presentationRevisionItems).values({
      id: uuidv7(),
      workroomId: presentation.workroomId,
      presentationRevisionId: revision.id,
      position: 51,
      kind: "note",
      fileId: null,
      displayNameSnapshot: "Concept board.png",
      caption: null,
      body: "words",
    }),
    (error: Error) => /presentation_revision_items_shape_check/.test(chain(error)),
  );

  // A note with a file, or a file with a body.
  await assert.rejects(
    () => db().insert(presentationRevisionItems).values({
      id: uuidv7(),
      workroomId: presentation.workroomId,
      presentationRevisionId: revision.id,
      position: 52,
      kind: "note",
      fileId,
      displayNameSnapshot: null,
      caption: null,
      body: "words",
    }),
    (error: Error) => /presentation_revision_items_shape_check/.test(chain(error)),
  );
});

/* -------------------------------------------------------------- the hash */

test("the hash answers one question: is this the same work the client saw", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  const presentation = (await findPresentation(id))!;

  const items = await listDraftItems(id);
  const content = toPresentationContent(presentation, items, r.publicId);

  // Same content, twice.
  assert.equal(contentHash(content), contentHash(toPresentationContent(presentation, items, r.publicId)));

  // Order is content.
  const reordered = toPresentationContent(presentation, [...items].reverse(), r.publicId);
  assert.notEqual(contentHash(content), contentHash(reordered));

  // Client-visible words are content.
  const reworded = toPresentationContent({ ...presentation, intro: "Different." }, items, r.publicId);
  assert.notEqual(contentHash(content), contentHash(reworded));

  // An internal-only change is not. `original_filename` is the field that
  // never travels; changing it must not change what the client was shown.
  const internalOnly = items.map((item) =>
    item.file ? { ...item, file: { ...item.file, originalFilename: "renamed-internally.png" } } : item,
  );
  assert.equal(contentHash(content), contentHash(toPresentationContent(presentation, internalOnly, r.publicId)));
});

test("a later draft edit cannot alter a published revision's hash", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);

  const first = await publishPresentation(actor, id, (await findPresentation(id))!.version);
  assert.ok(first.ok);

  assert.ok(
    (await updatePresentation(actor, id, (await findPresentation(id))!.version, {
      title: "Rewritten",
      intro: "Rewritten.",
    })).ok,
  );

  assert.equal((await listRevisions(id))[0]!.contentHash, first.value.hash);

  const second = await publishPresentation(actor, id, (await findPresentation(id))!.version);
  assert.ok(second.ok);
  assert.notEqual(second.value.hash, first.value.hash);
  assert.equal((await listRevisions(id)).find((rev) => rev.revisionNumber === 1)!.contentHash, first.value.hash);
});

/* ------------------------------------------------------------ concurrency */

test("two publishes at once produce one version and one clean refusal", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  const version = (await findPresentation(id))!.version;

  const [one, two] = await Promise.all([
    publishPresentation(actor, id, version),
    publishPresentation(actor, id, version),
  ]);

  const winners = [one, two].filter((outcome) => outcome.ok);
  const losers = [one, two].filter((outcome) => !outcome.ok);
  assert.equal(winners.length, 1, "both publishes succeeded");
  assert.equal(losers.length, 1);
  assert.equal(losers[0]!.ok === false && losers[0]!.reason, "conflict");

  // The important part: no orphan revision from the loser's rolled-back work.
  const revisions = await listRevisions(id);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0]!.revisionNumber, 1);

  const kinds = (await listActivity(r.workroomId)).map((event) => event.kind);
  assert.equal(kinds.filter((k) => k === "presentation.published").length, 1);
  assert.equal(kinds.filter((k) => k === "file.shared").length, 1, "the file was shared twice");
});

test("a stale edit changes nothing, whichever edit it is", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);

  const stale = (await findPresentation(id))!.version;

  // Somebody else gets there first.
  assert.ok((await updatePresentation(actor, id, stale, { title: "Theirs", intro: "Theirs." })).ok);

  const rows = await listDraftRows(id);

  for (const [what, attempt] of [
    ["title", () => updatePresentation(actor, id, stale, { title: "Mine", intro: "Mine." })],
    ["note", () => updateItem(actor, id, stale, rows[0]!.id, { caption: "Mine", body: "Mine." })],
    ["reorder", () => moveItem(actor, id, stale, rows[1]!.id, "up")],
    ["remove", () => removeItem(actor, id, stale, rows[0]!.id)],
    ["add", () => addNoteItem(actor, id, stale, { caption: "", body: "Mine." })],
    ["add a file", () => addFileItem(actor, id, stale, fileId, "Mine")],
    ["publish", () => publishPresentation(actor, id, stale)],
  ] as const) {
    const outcome = await attempt();
    assert.equal(outcome.ok, false, `a stale ${what} succeeded`);
    assert.equal(outcome.ok === false && outcome.reason, "conflict", `a stale ${what} gave the wrong reason`);
  }

  // Nothing above wrote anything, including the halves before the version check.
  assert.equal((await findPresentation(id))!.title, "Theirs");
  assert.equal((await listDraftRows(id)).length, 2);
  assert.equal((await listRevisions(id)).length, 0);
  assert.equal((await findFile(fileId))!.visibility, "internal");
});

/* -------------------------------------------------------------- rollback */

test("a failure at the last write of publish leaves no trace, and publishing then works", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);

  // Force the final statement of the transaction — the audit write — to fail.
  await db().execute(sql`
    CREATE OR REPLACE FUNCTION test_break_publish_audit() RETURNS trigger AS $$
    BEGIN
      IF NEW.action = 'presentation.published' THEN
        RAISE EXCEPTION 'forced failure at the last write';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);
  await db().execute(sql`
    CREATE TRIGGER test_break_publish BEFORE INSERT ON audit_events
    FOR EACH ROW EXECUTE FUNCTION test_break_publish_audit()
  `);

  try {
    const version = (await findPresentation(id))!.version;
    await assert.rejects(
      () => publishPresentation(actor, id, version),
      (error: Error) => /forced failure/.test(chain(error)),
    );

    // Everything the transaction had done by then is gone.
    const after = await findPresentation(id);
    assert.equal(after!.status, "draft", "the presentation was left published");
    assert.equal(after!.currentRevisionId, null, "current_revision_id survived a rollback");
    assert.equal(after!.publishedAt, null);
    assert.equal((await listRevisions(id)).length, 0, "an orphan revision survived");
    assert.equal(
      (await db().select().from(presentationRevisionItems)).length,
      0,
      "orphan revision items survived",
    );
    assert.equal((await findFile(fileId))!.visibility, "internal", "a file stayed half-shared");
    // The Workroom's own opening and joining rows predate this and stay. What
    // must not exist is anything the rolled-back publish would have written.
    assert.deepEqual(
      (await listActivity(r.workroomId))
        .map((event) => event.kind)
        .filter((kind) => kind.startsWith("presentation.") || kind === "file.shared"),
      [],
      "activity survived a publication that never happened",
    );
    assert.equal(
      (await listAuditEvents({ pageSize: 200 })).rows.filter((row) => row.action === "file.shared").length,
      0,
      "audit survived a publication that never happened",
    );
  } finally {
    await db().execute(sql`DROP TRIGGER test_break_publish ON audit_events`);
    await db().execute(sql`DROP FUNCTION test_break_publish_audit()`);
  }

  // And the same presentation publishes cleanly afterwards.
  const done = await publishPresentation(actor, id, (await findPresentation(id))!.version);
  assert.ok(done.ok, done.ok ? "" : done.message);
  assert.equal(done.value.revision, 1);
  assert.equal((await findFile(fileId))!.visibility, "shared");
});

/* ----------------------------------------------------- the two file guards */

test("a file a published presentation shows cannot be unshared", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const blocked = await setFileVisibility(actor, fileId, (await findFile(fileId))!.version, "internal");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "blocked");
  assert.match(blocked.ok === false ? blocked.message : "", /Brand direction/);
  assert.equal((await findFile(fileId))!.visibility, "shared");

  // Withdrawing the presentation releases it: sharing is a live authorization
  // state, and no client path depends on the file any more.
  assert.ok((await unpublishPresentation(actor, id, (await findPresentation(id))!.version)).ok);
  assert.ok((await setFileVisibility(actor, fileId, (await findFile(fileId))!.version, "internal")).ok);
});

test("a file any revision names cannot be archived, published or not", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);
  assert.ok((await unpublishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  // Unconditional, unlike the unshare guard: history must not lose its subject
  // whatever the Presentation's status is today.
  const refused = await archiveFile(actor, fileId, (await findFile(fileId))!.version);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "blocked");
  assert.equal((await findFile(fileId))!.archivedAt, null);
});

/* ------------------------------------------------------------- withdrawal */

test("withdrawing takes the whole presentation back, history included, and deletes nothing", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id, fileId } = await drafted(r);
  const publicId = (await findPresentation(id))!.publicId;

  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);
  assert.ok((await unpublishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  assert.deepEqual(await presentationsForViewer(r.contactId, r.publicId), []);
  assert.equal(await presentationForViewer(r.contactId, r.publicId, publicId), null);
  assert.equal(await presentationForViewer(r.contactId, r.publicId, publicId, 1), null, "history stayed reachable");
  assert.equal(await presentationForViewer(r.contactId, r.publicId, publicId, 2), null, "history stayed reachable");

  // Nothing was destroyed by it.
  assert.equal((await listRevisions(id)).length, 2);
  assert.equal((await findFile(fileId))!.visibility, "shared", "withdrawing unshared a file by itself");
  assert.ok((await listActivity(r.workroomId)).some((event) => event.kind === "presentation.published"));

  // Staff still read every version.
  assert.ok(await revisionForStaff((await findPresentation(id))!, 1));
});

test("archiving is refused while the client can still open it", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const refused = await archivePresentation(actor, id, (await findPresentation(id))!.version);
  assert.equal(refused.ok, false);
  assert.equal(refused.ok === false && refused.reason, "blocked");

  assert.ok((await unpublishPresentation(actor, id, (await findPresentation(id))!.version)).ok);
  assert.ok((await archivePresentation(actor, id, (await findPresentation(id))!.version)).ok);
});

/* ------------------------------------------------- isolation and leakage */

test("one client's presentation can reach nothing of another's", async () => {
  const a = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const b = await room("b", "Birch Group", "Ben Birch", "ben@birch.test");

  const mine = await drafted(a, "Alder direction");
  const theirs = await drafted(b, "Birch direction");
  assert.ok((await publishPresentation(actor, mine.id, (await findPresentation(mine.id))!.version)).ok);
  assert.ok((await publishPresentation(actor, theirs.id, (await findPresentation(theirs.id))!.version)).ok);

  const minePublic = (await findPresentation(mine.id))!.publicId;
  const theirsPublic = (await findPresentation(theirs.id))!.publicId;

  // Their id, my room. My id, their room. Their id, my membership.
  assert.equal(await presentationForViewer(a.contactId, a.publicId, theirsPublic), null);
  assert.equal(await presentationForViewer(a.contactId, b.publicId, theirsPublic), null);
  assert.equal(await presentationForViewer(b.contactId, b.publicId, minePublic), null);
  assert.equal(await presentationForViewer(a.contactId, a.publicId, theirsPublic, 1), null);

  const list = await presentationsForViewer(a.contactId, a.publicId);
  assert.deepEqual(
    list.map((entry) => entry.title),
    ["Alder direction"],
  );
});

test("nothing internal reaches a snapshot or a client projection", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const publicId = (await findPresentation(id))!.publicId;
  const view = await presentationForViewer(r.contactId, r.publicId, publicId);
  assert.ok(view);

  const serialised = JSON.stringify(view);
  for (const marker of MARKERS) {
    assert.ok(!serialised.includes(marker), `${marker} reached the client projection`);
  }
  for (const forbidden of ["storage_key", "storageKey", "previewKey", "storageEtag", "originalFilename"]) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} reached the client projection`);
  }
  // A storage key by its shape — `w/{uuid}/f/{uuid}` — rather than by the two
  // characters it starts with. A room's opaque public id ending in `w` would
  // make a substring check fail at random, which is a test that cries wolf
  // rather than a test that guards anything.
  assert.doesNotMatch(serialised, /w\/[0-9a-f]{8}-[0-9a-f]{4}-/, "a storage key reached the client projection");
  assert.doesNotMatch(serialised, /pending\//, "a pending key reached the client projection");

  // The stored snapshot is the same object, so the same is true of the row.
  const [row] = await db().select({ snapshot: presentationRevisions.snapshot }).from(presentationRevisions).limit(1);
  const stored = JSON.stringify(row!.snapshot);
  for (const marker of MARKERS) {
    assert.ok(!stored.includes(marker), `${marker} was frozen into a revision`);
  }

  // And no internal id travels: items are keyed by position.
  assert.ok(view.items.every((item) => typeof item.position === "number"));
  assert.ok(!serialised.includes(id), "the presentation's own uuid travelled");
  assert.ok(!serialised.includes(r.workroomId), "the workroom's uuid travelled");
});

test("audit records that a publication happened and never what it said", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const rows = (await listAuditEvents({ pageSize: 200 })).rows.filter((row) =>
    row.action.startsWith("presentation."),
  );
  assert.ok(rows.length > 0);

  const serialised = JSON.stringify(rows);
  for (const content of [
    "Here is the direction we developed",
    "Two weeks of looking",
    "Primary identity direction",
    "Where this came from",
    ...MARKERS,
  ]) {
    assert.ok(!serialised.includes(content), `audit carried content: ${content}`);
  }

  // It carries the title as a label and ids, which is what it is for.
  assert.ok(rows.some((row) => row.entityLabel === "Brand direction"));
  assert.ok(rows.some((row) => row.action === "presentation.published"));
});

test("the staff preview and the client read the same shape from the same projection", async () => {
  const r = await room("a", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { id } = await drafted(r);
  assert.ok((await publishPresentation(actor, id, (await findPresentation(id))!.version)).ok);

  const presentation = (await findPresentation(id))!;
  const staff = await revisionForStaff(presentation, 1);
  const client = await presentationForViewer(r.contactId, r.publicId, presentation.publicId);

  assert.ok(staff);
  assert.ok(client);
  assert.deepEqual(staff, client, "staff and client read different things from one revision");
});
