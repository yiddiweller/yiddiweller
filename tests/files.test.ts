import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { sql } from "drizzle-orm";

import { listAuditEvents, type AuditActor } from "../lib/db/audit.ts";
import { listActivity } from "../lib/db/activity.ts";
import { createClient } from "../lib/db/clients.ts";
import { attachContactToClient, createContact } from "../lib/db/contacts.ts";
import {
  abandonUpload,
  archiveFile,
  beginUpload,
  filesForViewer,
  fileForViewer,
  finalizeUpload,
  findFile,
  listFiles,
  renameFile,
  restoreFile,
  setFileVisibility,
  sweepPendingUploads,
  workroomBytes,
} from "../lib/db/files.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
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
import { contentDisposition } from "../lib/storage/presign.ts";
import { checkUpload, fileKind, formatBytes, previewable } from "../lib/storage/policy.ts";
import { isPendingKey, isPermanentKey, pendingKey, permanentKey } from "../lib/storage/keys.ts";
import { toClientFile } from "../lib/workrooms/delivery-view.ts";
import { S3Stub, useStub } from "./support/s3-stub.ts";

/**
 * Files, at the layer that decides them.
 *
 * Most of what is checked here is PostgreSQL and the order of two systems that
 * cannot commit together. The storage half runs against an in-process
 * S3-compatible server, so the real SDK builds real requests — but it accepts
 * any signature, so nothing here proves a signed URL would satisfy a real
 * provider. Only the beta bucket answers that.
 */

const actor: AuditActor = { id: uuidv7(), name: "Test Owner" };
const stub = new S3Stub();

/** Seeded into every internal field. None may reach a client projection. */
const MARKERS = ["MARKER-CLIENT-NOTE", "MARKER-PROJECT-NOTE", "MARKER-ORIGINAL-FILENAME"];

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

type Room = { clientId: string; contactId: string; projectId: string; workroomId: string; publicId: string };

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
    (await attachContactToClient(actor, {
      clientId: client.value,
      contactId: contact.value,
      role: "Day to day",
      isPrimary: true,
    })).ok,
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

  const accepted = await acceptWorkroomInvitation({
    token: await (async () => {
      const issued = await inviteToWorkroom(actor, {
        workroomId: made.value,
        contactId: contact.value,
      });
      assert.ok(issued.ok);
      return issued.value.token;
    })(),
    name: person,
  });
  assert.ok(accepted.ok);

  return {
    clientId: client.value,
    contactId: contact.value,
    projectId: project.value,
    workroomId: made.value,
    publicId: draft!.publicId,
  };
}

/** The whole upload, as the interface performs it. */
async function upload(
  r: Room,
  options: {
    filename?: string;
    contentType?: string;
    bytes?: Buffer;
    supersedes?: string;
    preview?: boolean;
    displayName?: string;
  } = {},
) {
  const bytes = options.bytes ?? Buffer.from("the actual file contents");
  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    // The default carries the marker on purpose: the internal filename is
    // exactly the field that must never travel, and `display_name` is a
    // separate thing somebody chose.
    filename: options.filename ?? "MARKER-ORIGINAL-FILENAME-v7-dontsend.pdf",
    contentType: options.contentType ?? "application/pdf",
    declaredSize: bytes.length,
    supersedesFileId: options.supersedes ?? null,
    ...(options.displayName ? { displayName: options.displayName } : {}),
  });
  assert.ok(ticket.ok, ticket.ok ? "" : ticket.message);

  // The browser's half, done here directly: bytes to the pending key.
  stub.place(ticket.value.key, bytes);
  if (options.preview) stub.place(`${permanentKey(r.workroomId, ticket.value.fileId)}/preview`, "tiny");

  const stored = await finalizeUpload(actor, ticket.value.fileId, {
    declaredSize: bytes.length,
    previewUploaded: options.preview ?? false,
  });
  assert.ok(stored.ok, stored.ok ? "" : stored.message);
  return stored.value;
}

/* ------------------------------------------------------------ the policy */

test("almost anything may be stored; only a short list may be rendered", () => {
  for (const name of ["brand.sketch", "layout.indd", "cut.mov", "deliverables.zip", "logo.ai"]) {
    assert.equal(checkUpload({ filename: name, contentType: "application/octet-stream", declaredSize: 10 }).ok, true, name);
  }
  for (const name of ["payload.exe", "run.sh", "installer.msi", "thing.bat"]) {
    assert.equal(checkUpload({ filename: name, contentType: "application/octet-stream", declaredSize: 10 }).ok, false, name);
  }
  assert.equal(checkUpload({ filename: "page.html", contentType: "text/html", declaredSize: 10 }).ok, false);

  // SVG is storable and never previewable: decoding one runs its contents.
  assert.equal(checkUpload({ filename: "mark.svg", contentType: "image/svg+xml", declaredSize: 10 }).ok, true);
  assert.equal(previewable("image/svg+xml"), false);
  assert.equal(previewable("image/png"), true);

  assert.equal(checkUpload({ filename: "big.mov", contentType: "video/quicktime", declaredSize: 3e9 }).ok, false);
  assert.equal(checkUpload({ filename: "empty.pdf", contentType: "application/pdf", declaredSize: 0 }).ok, false);

  assert.equal(fileKind("image/png"), "image");
  assert.equal(fileKind("application/pdf"), "pdf");
  assert.equal(fileKind("image/svg+xml"), "image");
  assert.equal(formatBytes(2516582), "2.4 MB");
});

test("a hostile filename cannot escape a Content-Disposition header", () => {
  const nasty = 'a"; filename="evil.exe\r\nX-Injected: yes';
  const header = contentDisposition(nasty);
  assert.ok(!header.includes("\r"), "a newline survived");
  assert.ok(!header.includes("\n"), "a newline survived");
  assert.match(header, /^attachment; filename="[A-Za-z0-9._ -]*"; filename\*=UTF-8''/);
  // Exactly two quoted-string quotes: the pair around the ASCII fallback.
  assert.equal(header.split('"').length - 1, 2);
  // Not a path traversal defence — a filename is not a path — but a name that
  // a naive client might join onto a directory should not carry `..`.
  assert.equal(contentDisposition("../../etc/passwd").split(";")[1]!.includes(".."), false);
  assert.match(contentDisposition("⟡⟡⟡"), /filename="download"/);
  // The real name still travels, for clients that read RFC 5987.
  assert.match(contentDisposition("Identité.pdf"), /filename\*=UTF-8''Identit%C3%A9\.pdf/);
});

test("no caller string reaches a storage key", () => {
  const id = uuidv7();
  assert.equal(pendingKey(id), `pending/${id}`);
  assert.ok(isPendingKey(pendingKey(id)));
  assert.ok(!isPermanentKey(pendingKey(id)));
  assert.ok(isPermanentKey(permanentKey(uuidv7(), id)));
  // The sweep's guard refuses a traversal even if one were somehow stored.
  assert.equal(isPendingKey("pending/../w/room/f/file"), false);
  assert.equal(isPendingKey("w/room/f/file"), false);
});

/* ------------------------------------------------------------ the upload */

test("a row exists before its bytes, and is ready only after they are verified", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const bytes = Buffer.from("real contents");

  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "concept.pdf",
    contentType: "application/pdf",
    declaredSize: bytes.length,
  });
  assert.ok(ticket.ok);
  assert.equal(ticket.value.strategy, "single");

  const reserved = await findFile(ticket.value.fileId);
  assert.equal(reserved!.status, "pending");
  assert.equal(reserved!.byteSize, null, "a pending row claims no size");
  assert.ok(isPendingKey(reserved!.storageKey));
  assert.equal((await listFiles(r.workroomId)).length, 0, "a reservation is not a file");

  stub.place(ticket.value.key, bytes);
  const stored = await finalizeUpload(actor, ticket.value.fileId, { declaredSize: bytes.length });
  assert.ok(stored.ok);

  assert.equal(stored.value.status, "ready");
  assert.equal(stored.value.byteSize, bytes.length);
  assert.ok(isPermanentKey(stored.value.storageKey));

  // The pending object is gone and the permanent one exists.
  assert.equal(stub.objects.has(ticket.value.key), false, "the pending object survived");
  assert.equal(stub.objects.has(stored.value.storageKey), true);
  assert.equal((await listFiles(r.workroomId)).length, 1);
});

test("a size that does not match what arrived is refused, and nothing is stored", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "concept.pdf",
    contentType: "application/pdf",
    declaredSize: 1000,
  });
  assert.ok(ticket.ok);

  // The browser declared a thousand bytes and sent nine.
  stub.place(ticket.value.key, Buffer.from("not 1000!"));
  const refused = await finalizeUpload(actor, ticket.value.fileId, { declaredSize: 1000 });

  assert.equal(refused.ok, false);
  assert.equal((await findFile(ticket.value.fileId))!.status, "pending", "it became ready anyway");
  assert.equal(stub.objects.size, 0, "the bad object was left behind");
  assert.equal((await listFiles(r.workroomId)).length, 0);
});

test("bytes that never arrived are refused rather than invented", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "concept.pdf",
    contentType: "application/pdf",
    declaredSize: 12,
  });
  assert.ok(ticket.ok);

  // Nothing was uploaded.
  const refused = await finalizeUpload(actor, ticket.value.fileId, { declaredSize: 12 });
  assert.equal(refused.ok, false);
  assert.equal((await findFile(ticket.value.fileId))!.status, "pending");
});

test("finalizing twice stores one file, not two", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const bytes = Buffer.from("once");

  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "a.pdf",
    contentType: "application/pdf",
    declaredSize: bytes.length,
  });
  assert.ok(ticket.ok);
  stub.place(ticket.value.key, bytes);

  const first = await finalizeUpload(actor, ticket.value.fileId, { declaredSize: bytes.length });
  const second = await finalizeUpload(actor, ticket.value.fileId, { declaredSize: bytes.length });

  assert.ok(first.ok);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "already_done");
  assert.equal((await listFiles(r.workroomId)).length, 1);
  assert.equal((await listAuditEvents({ action: "file.uploaded" })).total, 1);
});

test("an old upload URL cannot change a finalized file", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const original = Buffer.from("the approved bytes");

  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "final.pdf",
    contentType: "application/pdf",
    declaredSize: original.length,
  });
  assert.ok(ticket.ok);
  stub.place(ticket.value.key, original);
  const stored = await finalizeUpload(actor, ticket.value.fileId, { declaredSize: original.length });
  assert.ok(stored.ok);

  // Somebody replays the upload URL they still hold. It points at `pending/`,
  // which is a different key from the permanent one — so the worst it can do is
  // recreate a transient object the sweep will remove.
  stub.place(ticket.value.key, Buffer.from("TAMPERED"));

  assert.equal(
    stub.objects.get(stored.value.storageKey)!.body.toString(),
    "the approved bytes",
    "a stale upload URL reached the permanent object",
  );
  assert.notEqual(ticket.value.key, stored.value.storageKey);
});

test("a file above the threshold goes up in parts", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const ticket = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "cut.mov",
    contentType: "video/mp4",
    declaredSize: 300 * 1024 * 1024,
  });
  assert.ok(ticket.ok);
  assert.equal(ticket.value.strategy, "multipart");
  assert.equal(ticket.value.parts, Math.ceil((300 * 1024 * 1024) / (16 * 1024 * 1024)));
  assert.equal(ticket.value.partSize, 16 * 1024 * 1024);
});

/* --------------------------------------------------------------- the edits */

test("sharing a file tells the client, and unsharing does not", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const file = await upload(r, { filename: "Brand guidelines.pdf" });
  assert.equal(file.visibility, "internal");

  const shared = await setFileVisibility(actor, file.id, file.version, "shared");
  assert.ok(shared.ok);

  const timeline = await listActivity(r.workroomId);
  const entries = timeline.filter((row) => row.kind === "file.shared");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.subject, "Brand guidelines.pdf");

  const after = await findFile(file.id);
  const back = await setFileVisibility(actor, file.id, after!.version, "internal");
  assert.ok(back.ok);

  assert.equal(
    (await listActivity(r.workroomId)).filter((row) => row.kind === "file.shared").length,
    1,
    "taking something back announced itself",
  );
  assert.equal((await listAuditEvents({ action: "file.unshared" })).total, 1, "but audit knows");
});

test("a stale version is refused on every edit", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const file = await upload(r);
  const stale = file.version;

  assert.ok((await renameFile(actor, file.id, stale, "First")).ok);

  for (const attempt of [
    () => renameFile(actor, file.id, stale, "Second"),
    () => setFileVisibility(actor, file.id, stale, "shared"),
    () => archiveFile(actor, file.id, stale),
  ]) {
    const refused = await attempt();
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false && refused.reason, "conflict");
  }

  assert.equal((await findFile(file.id))!.displayName, "First", "a loser overwrote the winner");
});

test("a file is archived, never deleted, and restored from where it was", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const file = await upload(r);
  assert.ok((await setFileVisibility(actor, file.id, file.version, "shared")).ok);

  const shared = await findFile(file.id);
  assert.ok((await archiveFile(actor, file.id, shared!.version)).ok);

  assert.equal((await listFiles(r.workroomId)).length, 0);
  assert.equal((await listFiles(r.workroomId, { includeArchived: true })).length, 1);
  assert.equal((await filesForViewer(r.contactId, r.publicId)).length, 0, "a client still sees it");
  assert.ok(stub.objects.has(shared!.storageKey), "the bytes were deleted");

  const archived = await findFile(file.id);
  assert.ok((await restoreFile(actor, file.id, archived!.version)).ok);
  assert.equal((await listFiles(r.workroomId)).length, 1);
});

test("replacement is a new file, and the old one stays", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const first = await upload(r, { filename: "logo-v1.ai", bytes: Buffer.from("version one") });
  const second = await upload(r, {
    filename: "logo-v2.ai",
    bytes: Buffer.from("version two"),
    supersedes: first.id,
  });

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.storageKey, second.storageKey);
  assert.equal(second.supersedesFileId, first.id);

  // Both rows, both objects. Nothing was rewritten in place.
  assert.equal((await listFiles(r.workroomId)).length, 2);
  assert.equal(stub.objects.get(first.storageKey)!.body.toString(), "version one");
  assert.equal(stub.objects.get(second.storageKey)!.body.toString(), "version two");
  assert.equal((await listAuditEvents({ action: "file.replaced" })).total, 1);
});

/* ---------------------------------------------------------------- tenancy */

test("a revision item cannot reference another workroom's file", async () => {
  const a = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const b = await room("B", "Birch Group", "Ben Birch", "ben@birch.test");
  const theirs = await upload(b);

  // A presentation in A, pointing at B's file. PostgreSQL refuses it.
  const presentationId = uuidv7();
  await db().insert(presentations).values({
    id: presentationId,
    publicId: "aaaaaaaaaaaaaaaaaaaaaaaaab",
    workroomId: a.workroomId,
    title: "Concepts",
  });

  await assert.rejects(
    () =>
      db().insert(presentationItems).values({
        id: uuidv7(),
        workroomId: a.workroomId,
        presentationId,
        fileId: theirs.id,
        kind: "file",
        position: 0,
      }),
    "a cross-workroom reference was accepted",
  );

  // And the same file in its own workroom is accepted, so this is the
  // constraint working rather than the insert being broken.
  const mine = await upload(a);
  await db().insert(presentationItems).values({
    id: uuidv7(),
    workroomId: a.workroomId,
    presentationId,
    fileId: mine.id,
    kind: "file",
    position: 0,
  });
});

test("one client's viewer reaches nothing of another's", async () => {
  const a = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const b = await room("B", "Birch Group", "Ben Birch", "ben@birch.test");

  const mine = await upload(a, { filename: "alder.pdf" });
  const theirs = await upload(b, { filename: "birch.pdf" });
  assert.ok((await setFileVisibility(actor, mine.id, mine.version, "shared")).ok);
  assert.ok((await setFileVisibility(actor, theirs.id, theirs.version, "shared")).ok);

  const forA = await filesForViewer(a.contactId, a.publicId);
  assert.equal(forA.length, 1);
  assert.equal(forA[0]!.displayName, "alder.pdf");

  // Symmetrically, and by public id as the download route asks.
  assert.equal((await filesForViewer(b.contactId, b.publicId)).length, 1);
  assert.equal(await fileForViewer(a.contactId, a.publicId, theirs.publicId), null);
  assert.equal(await fileForViewer(b.contactId, b.publicId, mine.publicId), null);
  assert.equal(await fileForViewer(a.contactId, b.publicId, theirs.publicId), null);
});

test("a client sees only what was deliberately given to them", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const internal = await upload(r, { filename: "internal.pdf" });
  const shared = await upload(r, { filename: "shared.pdf" });
  const archived = await upload(r, { filename: "archived.pdf" });

  assert.ok((await setFileVisibility(actor, shared.id, shared.version, "shared")).ok);
  assert.ok((await setFileVisibility(actor, archived.id, archived.version, "shared")).ok);
  const toArchive = await findFile(archived.id);
  assert.ok((await archiveFile(actor, archived.id, toArchive!.version)).ok);

  // And one that was never finished.
  const pending = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "pending.pdf",
    contentType: "application/pdf",
    declaredSize: 10,
  });
  assert.ok(pending.ok);

  const visible = await filesForViewer(r.contactId, r.publicId);
  assert.deepEqual(visible.map((file) => file.displayName), ["shared.pdf"]);

  for (const hidden of [internal.publicId, archived.publicId]) {
    assert.equal(await fileForViewer(r.contactId, r.publicId, hidden), null);
  }
});

test("the client projection carries nothing internal", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const file = await upload(r, {
    filename: "MARKER-ORIGINAL-FILENAME-v7-dontsend.pdf",
    displayName: "Brand guidelines",
    preview: true,
  });
  assert.ok((await setFileVisibility(actor, file.id, file.version, "shared")).ok);

  const row = (await filesForViewer(r.contactId, r.publicId))[0]!;
  const view = toClientFile(row, r.publicId);
  const serialised = JSON.stringify(view);

  for (const marker of MARKERS) {
    assert.ok(!serialised.includes(marker), `${marker} reached the client`);
  }
  assert.ok(!serialised.includes(row.storageKey), "a storage key reached the client");
  assert.ok(!serialised.includes(row.id), "an internal id reached the client");
  assert.ok(!serialised.includes("application/pdf"), "a raw content type reached the client");

  assert.deepEqual(Object.keys(view).sort(), ["downloadPath", "id", "kind", "name", "previewPath", "size"]);
  assert.equal(view.id, row.publicId);
  assert.equal(view.kind, "pdf");
  assert.match(view.size, /\d/);
});

/* ------------------------------------------------------------------ sweep */

test("the sweep removes what was abandoned and refuses to touch anything else", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const stored = await upload(r, { filename: "kept.pdf" });

  const abandoned = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "never-finished.pdf",
    contentType: "application/pdf",
    declaredSize: 10,
  });
  assert.ok(abandoned.ok);
  stub.place(abandoned.value.key, "half an upload");

  // Too recent: the sweep leaves an upload that may still be in progress.
  const early = await sweepPendingUploads({ olderThanHours: 24 });
  assert.equal(early.examined, 0);
  assert.equal(await findFile(abandoned.value.fileId) !== null, true);

  // Old enough.
  await db().execute(
    sql`UPDATE workroom_files SET created_at = now() - interval '48 hours' WHERE status = 'pending'`,
  );
  const swept = await sweepPendingUploads({ olderThanHours: 24 });

  assert.deepEqual(swept, { examined: 1, objectsDeleted: 1, rowsDeleted: 1 });
  assert.equal(await findFile(abandoned.value.fileId), null);
  assert.equal(stub.objects.has(abandoned.value.key), false);

  // And the ready file is untouched, in both places.
  assert.ok(stub.objects.has(stored.storageKey));
  assert.equal((await listFiles(r.workroomId)).length, 1);

  // Idempotent: a second run finds nothing and changes nothing.
  assert.deepEqual(await sweepPendingUploads({ olderThanHours: 24 }), {
    examined: 0,
    objectsDeleted: 0,
    rowsDeleted: 0,
  });
});

test("the sweep refuses a permanent key even if a row somehow carries one", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const stored = await upload(r, { filename: "precious.pdf" });

  // A state the schema's own CHECK refuses, forced in to prove the sweep's
  // guard is a second line rather than the only one. The `finally` is not
  // tidiness: a test that drops a constraint and then fails leaves every later
  // run against a weakened schema, which is how a green suite starts lying.
  const KEY_SHAPE =
    "(status = 'pending' AND storage_key LIKE 'pending/%') OR (status = 'ready' AND storage_key LIKE 'w/%')";
  const READY_SHAPE =
    "(status = 'pending' AND byte_size IS NULL AND storage_etag IS NULL) OR (status = 'ready' AND byte_size IS NOT NULL AND storage_etag IS NOT NULL)";

  // A different permanent key from the real file's — `storage_key` is unique,
  // and the point is a permanent key on a pending row, not a duplicate one.
  const rogue = uuidv7();
  const rogueKey = permanentKey(r.workroomId, rogue);
  stub.place(rogueKey, "bytes that must survive");

  try {
    await db().execute(sql`ALTER TABLE workroom_files DROP CONSTRAINT workroom_files_key_shape_check`);
    await db().execute(sql`ALTER TABLE workroom_files DROP CONSTRAINT workroom_files_ready_shape_check`);

    await db().insert(workroomFiles).values({
      id: rogue,
      publicId: "aaaaaaaaaaaaaaaaaaaaaaaaac",
      workroomId: r.workroomId,
      displayName: "rogue",
      originalFilename: "rogue",
      contentType: "application/pdf",
      storageKey: rogueKey, // a permanent key on a pending row
      status: "pending",
    });
    await db().execute(
      sql`UPDATE workroom_files SET created_at = now() - interval '48 hours' WHERE id = ${rogue}`,
    );

    const swept = await sweepPendingUploads({ olderThanHours: 24 });

    assert.equal(swept.examined, 1);
    assert.equal(swept.objectsDeleted, 0, "the sweep deleted a permanent object");
    assert.equal(swept.rowsDeleted, 0);
    assert.ok(stub.objects.has(rogueKey), "the sweep deleted a permanent object");
    assert.ok(stub.objects.has(stored.storageKey), "a real file's bytes were deleted");
  } finally {
    await db().delete(workroomFiles).where(sql`id = ${rogue}`);
    await db().execute(
      sql.raw(`ALTER TABLE workroom_files ADD CONSTRAINT workroom_files_key_shape_check CHECK (${KEY_SHAPE})`),
    );
    await db().execute(
      sql.raw(`ALTER TABLE workroom_files ADD CONSTRAINT workroom_files_ready_shape_check CHECK (${READY_SHAPE})`),
    );
  }
});

test("abandoning an upload removes it; abandoning a stored file does not", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const stored = await upload(r);

  const refused = await abandonUpload(stored.id);
  assert.equal(refused.ok, false);
  assert.ok(await findFile(stored.id));

  const pending = await beginUpload(actor, {
    workroomId: r.workroomId,
    filename: "gone.pdf",
    contentType: "application/pdf",
    declaredSize: 10,
  });
  assert.ok(pending.ok);
  stub.place(pending.value.key, "partial");

  assert.ok((await abandonUpload(pending.value.fileId)).ok);
  assert.equal(await findFile(pending.value.fileId), null);
  assert.equal(stub.objects.has(pending.value.key), false);
});

/* ------------------------------------------------------------- the record */

test("audit records the actions and none of the content", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const file = await upload(r, {
    filename: "MARKER-ORIGINAL-FILENAME-v7-dontsend.pdf",
    displayName: "Concepts",
  });
  assert.ok((await renameFile(actor, file.id, file.version, "Brand guidelines")).ok);

  // The two fields diverge and the internal one never follows the rename.
  assert.equal((await findFile(file.id))!.originalFilename, "MARKER-ORIGINAL-FILENAME-v7-dontsend.pdf");

  const renamed = await findFile(file.id);
  assert.ok((await setFileVisibility(actor, file.id, renamed!.version, "shared")).ok);

  const events = await listAuditEvents({ entityType: "workroom_file" });
  const actions = events.rows.map((row) => row.action).sort();
  assert.deepEqual(actions, ["file.renamed", "file.shared", "file.uploaded"]);

  // Field names and ids, never values — and never the original filename, which
  // is the one thing on a file that is written for the studio, not the client.
  const serialised = JSON.stringify(events.rows);
  assert.ok(!serialised.includes("MARKER-ORIGINAL-FILENAME"), "an internal filename reached audit");
  assert.ok(!serialised.includes("pending/"), "a storage key reached audit");
  assert.ok(!serialised.includes("w/"), "a storage key reached audit");
});

test("a workroom knows how much it is holding", async () => {
  const r = await room("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  assert.equal(await workroomBytes(r.workroomId), 0);

  await upload(r, { bytes: Buffer.alloc(1000) });
  await upload(r, { bytes: Buffer.alloc(2000) });

  assert.equal(await workroomBytes(r.workroomId), 3000);
});
