import assert from "node:assert/strict";

import { eq, sql } from "drizzle-orm";

import { type AuditActor } from "../../lib/db/audit.ts";
import { createClient } from "../../lib/db/clients.ts";
import { attachContactToClient, createContact } from "../../lib/db/contacts.ts";
import { db } from "../../lib/db/index.ts";
import { uuidv7 } from "../../lib/db/id.ts";
import {
  addFileItem,
  addNoteItem,
  createPresentation,
  findPresentation,
  publishPresentation,
} from "../../lib/db/presentations.ts";
import { createProject } from "../../lib/db/projects.ts";
import { requestReview, type ClientActor, type StaffActor } from "../../lib/db/reviews.ts";
import {
  type ClientReviewNote,
  type ClientReviewReply,
} from "../../lib/workrooms/review-view.ts";
import { createWorkroom, publishWorkroom } from "../../lib/db/workrooms.ts";
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
} from "../../lib/db/schema.ts";

/**
 * One Workroom, two published versions and two people who may read them.
 *
 * Shared by every Review suite rather than copied into each. A fixture that
 * exists twice drifts exactly like a projection that exists twice, and the
 * second copy is always the one that quietly stops seeding the marker a leak
 * test is looking for.
 */

export const owner: AuditActor = { id: uuidv7(), name: "Test Owner" };
export const staff: StaffActor = { side: "studio", userId: owner.id, name: owner.name };

/** Seeded into every field a Review surface must never carry. */
export const MARKERS = {
  removedRoot: "MARKER-REMOVED-ROOT",
  removedReply: "MARKER-REMOVED-REPLY",
  clientEmail: "marker-client-email@example.com",
  staffEmail: "marker-staff-email@example.com",
  storageKey: "MARKER-STORAGE-KEY",
  previewKey: "MARKER-PREVIEW-KEY",
  originalFilename: "MARKER-ORIGINAL-FILENAME",
  clientNote: "MARKER-CLIENT-NOTE",
  projectNote: "MARKER-PROJECT-NOTE",
  workroomSummary: "MARKER-WORKROOM-SUMMARY",
};

/** Anything shaped like a database identifier is a leak, named or not. */
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/* ------------------------------------------------------------------ wipe */

export const GUARDED = [
  "presentation_review_notes",
  "presentation_reviews",
  "presentation_approvals",
  "presentation_revision_items",
  "presentation_revisions",
];

export async function wipe(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);

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

/** The owner row every fixture writes as. Created once per suite. */
export async function seedOwner(): Promise<void> {
  await wipe();
  await db().delete(user);
  await db()
    .insert(user)
    .values({ id: owner.id, name: owner.name, email: MARKERS.staffEmail, role: "owner" });
}

export async function clearOwner(): Promise<void> {
  await wipe();
  await db().delete(user);
}

/* ----------------------------------------------------------------- setup */

export type Stage = {
  workroomId: string;
  room: string;
  presentationId: string;
  presentation: string;
  ana: ClientActor;
  ben: ClientActor;
};

let seq = 0;

/**
 * A file row written straight in, rather than uploaded.
 *
 * The projection cares only that an item has a viewer kind, so driving the
 * whole presign-verify-copy flow would test Stage A a second time and need a
 * storage stub to do it. The marker strings go in the columns a projection must
 * never reach.
 */
export async function file(workroomId: string, name: string, contentType: string): Promise<string> {
  const id = uuidv7();
  await db().insert(workroomFiles).values({
    id,
    publicId: `f${id.replace(/-/g, "").slice(0, 25)}`,
    workroomId,
    displayName: name,
    originalFilename: `${MARKERS.originalFilename}-${name}`,
    contentType,
    byteSize: 1024,
    storageKey: `w/${workroomId}/f/${id}/${MARKERS.storageKey}`,
    storageEtag: `"${id}"`,
    previewKey: `w/${workroomId}/f/${id}/${MARKERS.previewKey}`,
    status: "ready",
    visibility: "internal",
    createdBy: owner.id,
  });
  return id;
}

export async function person(tag: string, workroomId: string | null, email: string): Promise<ClientActor> {
  const contact = await createContact(owner, {
    name: `${tag} Person`,
    email,
    emailNormalized: email,
    phone: null,
    title: null,
    notes: "",
  });
  assert.ok(contact.ok);

  const identityId = uuidv7();
  await db().insert(clientIdentity).values({
    id: identityId,
    name: `${tag} Person`,
    email,
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

/**
 * One Workroom, published twice, holding a written note and four kinds of file
 * — so every anchor the vocabulary allows has somewhere real to point.
 *
 * Positions in Revision 2: 0 note, 1 image, 2 video, 3 audio, 4 pdf.
 */
export async function stage(tag = `P${seq++}`): Promise<Stage> {
  const client = await createClient(owner, {
    accountType: "organization",
    name: `${tag} Studio`,
    website: null,
    domain: null,
    status: "active",
    notes: MARKERS.clientNote,
  });
  assert.ok(client.ok);

  const project = await createProject(owner, {
    clientId: client.value,
    name: `${tag} work`,
    status: "active",
    description: "",
    notes: MARKERS.projectNote,
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(project.ok);

  const made = await createWorkroom(owner, {
    projectId: project.value,
    title: `${tag} work`,
    summary: MARKERS.workroomSummary,
  });
  assert.ok(made.ok);
  const workroomId = made.value;
  assert.ok((await publishWorkroom(owner, workroomId, 1)).ok);

  const room = (await db()
    .select({ publicId: workrooms.publicId })
    .from(workrooms)
    .where(eq(workrooms.id, workroomId)))[0]!.publicId;

  const ana = await person(`${tag}na`, workroomId, `${tag.toLowerCase()}-${MARKERS.clientEmail}`);
  const ben = await person(`${tag}en`, workroomId, `${tag.toLowerCase()}-ben@example.com`);
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
    intro: "A direction.",
  });
  assert.ok(presentation.ok);
  const presentationId = presentation.value;

  const v = async () => (await findPresentation(presentationId))!.version;
  assert.ok((await addNoteItem(owner, presentationId, await v(), { caption: "One", body: "Words." })).ok);
  assert.ok((await publishPresentation(owner, presentationId, await v())).ok);

  for (const [name, type, caption] of [
    ["Board.png", "image/png", "The board"],
    ["Motion.mp4", "video/mp4", "The motion"],
    ["Sketch.mp3", "audio/mpeg", "The sound"],
    ["Deck.pdf", "application/pdf", "The deck"],
  ] as const) {
    const id = await file(workroomId, name, type);
    assert.ok((await addFileItem(owner, presentationId, await v(), id, caption)).ok);
  }
  assert.ok((await publishPresentation(owner, presentationId, await v())).ok);

  const publicId = (await findPresentation(presentationId))!.publicId;
  return { workroomId, room, presentationId, presentation: publicId, ana, ben };
}

export async function round(s: Stage): Promise<string> {
  const current = (await findPresentation(s.presentationId))!.currentRevisionId!;
  const made = await requestReview(staff, current);
  assert.ok(made.ok, made.ok ? "" : made.message);
  return made.value;
}


/* ------------------------------------------------------- narrowing helpers */

/**
 * The note, asserted to still be readable.
 *
 * A removed note is a different type carrying nothing but its ordinal, so a
 * test that wants an author or a body has to say so — which is the point.
 * These exist so that saying so stays one word rather than five lines of
 * narrowing in every assertion.
 */
export function live(
  note: ClientReviewNote | undefined,
  what = "note",
): Extract<ClientReviewNote, { removed: false }> {
  assert.ok(note, `${what} is not there at all`);
  assert.equal(note.removed, false, `${what} is a tombstone`);
  return note as Extract<ClientReviewNote, { removed: false }>;
}

/** The same, for a reply. */
export function liveReply(
  reply: ClientReviewReply | undefined,
  what = "reply",
): Extract<ClientReviewReply, { removed: false }> {
  assert.ok(reply, `${what} is not there at all`);
  assert.equal(reply.removed, false, `${what} is a tombstone`);
  return reply as Extract<ClientReviewReply, { removed: false }>;
}

/** A tombstone, asserted to carry nothing but its ordinal. */
export function tombstone(
  note: ClientReviewNote | ClientReviewReply | undefined,
  what = "note",
): void {
  assert.ok(note, `${what} is not there at all`);
  assert.equal(note.removed, true, `${what} is not a tombstone`);
  assert.deepEqual(
    Object.keys(note).sort(),
    ["n", "removed"],
    `${what} carries more than the fact that it happened`,
  );
}
