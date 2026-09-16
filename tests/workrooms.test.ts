import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { sql } from "drizzle-orm";

import { listAuditEvents, type AuditActor } from "../lib/db/audit.ts";
import { listActivity } from "../lib/db/activity.ts";
import { createClient } from "../lib/db/clients.ts";
import { archiveContact, attachContactToClient, createContact, findContact } from "../lib/db/contacts.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { archiveProject, createProject, findProject, updateProject } from "../lib/db/projects.ts";
import {
  acceptWorkroomInvitation,
  archiveWorkroom,
  canSignIn,
  createWorkroom,
  findWorkroom,
  inspectWorkroomInvitation,
  invitableContacts,
  inviteToWorkroom,
  listWorkroomMembers,
  publishWorkroom,
  resendWorkroomInvitation,
  restoreMembership,
  revokeMembership,
  revokeWorkroomInvitation,
  setIdentityStatus,
  unpublishWorkroom,
  workroomForViewer,
  workroomsForViewer,
} from "../lib/db/workrooms.ts";
import { isPublicId } from "../lib/workrooms/id.ts";
import { toClientActivity, toClientWorkroomView } from "../lib/workrooms/view.ts";
import {
  clientIdentity,
  clientSession,
  clientContacts,
  clients,
  contacts,
  projects,
  user,
  workroomActivity,
  workroomInvitations,
  workroomMembers,
  workrooms,
} from "../lib/db/schema.ts";

/**
 * Client workrooms, at the layer that decides them.
 *
 * Most of what is checked here is PostgreSQL: the unique index that makes one
 * workroom per project true no matter who presses first, the partial index that
 * collapses two simultaneous invitations into one, the membership row that
 * revocation reads on every request. The rest is the boundary between what the
 * studio knows and what a client receives, which is the whole point of the
 * build.
 */

const actor: AuditActor = { id: uuidv7(), name: "Test Owner" };

/** Markers seeded into every internal field a client must never see. */
const MARKERS = [
  "MARKER-CLIENT-NOTE",
  "MARKER-CONTACT-NOTE",
  "MARKER-PROJECT-NOTE",
  "MARKER-PROJECT-DESCRIPTION",
];

async function clearAudit(): Promise<void> {
  await db().execute(sql`ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_truncate`);
  await db().execute(sql`TRUNCATE audit_events`);
  await db().execute(sql`ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_truncate`);
}

async function wipe(): Promise<void> {
  // Audit first, and that order is not incidental: an audit row pointing at an
  // actor makes that actor undeletable, because the FK's ON DELETE SET NULL is
  // an UPDATE of `audit_events` and the append-only trigger refuses it. Nothing
  // in the product ever deletes a person — staff are deactivated and client
  // identities disabled — so in production this only ever bites a mistake.
  await clearAudit();
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

beforeEach(wipe);

after(async () => {
  await wipe();
  await db().delete(user);
  await closeDb();
});

/* ------------------------------------------------------------------ setup */

type Tenant = { clientId: string; contactId: string; projectId: string; workroomId: string };

async function tenant(tag: string, name: string, person: string, email: string): Promise<Tenant> {
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
    notes: `MARKER-CONTACT-NOTE-${tag}`,
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
    description: `MARKER-PROJECT-DESCRIPTION-${tag}`,
    notes: `MARKER-PROJECT-NOTE-${tag}`,
    ownerId: null,
    startsOn: "2026-08-01",
    targetOn: "2026-12-01",
  });
  assert.ok(project.ok);

  const workroom = await createWorkroom(actor, {
    projectId: project.value,
    title: `${name} rebrand`,
    summary: "A private space for this work.",
  });
  assert.ok(workroom.ok);

  return {
    clientId: client.value,
    contactId: contact.value,
    projectId: project.value,
    workroomId: workroom.value,
  };
}

async function published(tag: string, name: string, person: string, email: string): Promise<Tenant> {
  const made = await tenant(tag, name, person, email);
  const room = await findWorkroom(made.workroomId);
  assert.ok((await publishWorkroom(actor, made.workroomId, room!.version)).ok);
  return made;
}

async function invite(t: Tenant): Promise<string> {
  const issued = await inviteToWorkroom(actor, { workroomId: t.workroomId, contactId: t.contactId });
  assert.ok(issued.ok, issued.ok ? "" : issued.message);
  return issued.value.token;
}

async function joined(t: Tenant): Promise<string> {
  const accepted = await acceptWorkroomInvitation({ token: await invite(t), name: "" });
  assert.ok(accepted.ok);
  return accepted.identityId;
}

/**
 * Everything an acceptance touches, counted in one place.
 *
 * Build 003's lesson, written down: a losing transaction had rolled back its
 * lead and left its contact behind, and the test passed because it only counted
 * leads. So a race is never asserted on its primary record alone — every table
 * the winning path writes to is counted, including the two it writes history
 * into, which have different rules from each other and from everything else.
 */
async function sideEffects() {
  // Through the reader Studio itself uses, so this counts what an Owner would
  // actually be shown rather than what is merely in the table.
  const byAction = async (action: string) => (await listAuditEvents({ action })).total;
  const count = async (query: Promise<unknown[]>) => (await query).length;

  return {
    identities: await count(db().select().from(clientIdentity)),
    members: await count(db().select().from(workroomMembers)),
    accepted: await count(
      db().select().from(workroomInvitations).where(sql`accepted_at IS NOT NULL`),
    ),
    invitations: await count(db().select().from(workroomInvitations)),
    joinedActivity: await count(
      db().select().from(workroomActivity).where(sql`kind = 'workroom.joined'`),
    ),
    activity: await count(db().select().from(workroomActivity)),
    auditIdentityCreated: await byAction("client_identity.created"),
    auditAccepted: await byAction("workroom_invitation.accepted"),
    auditInvited: await byAction("workroom_invitation.created"),
  };
}

/* -------------------------------------------------------------- the model */

test("a project has at most one workroom, whoever presses first", async () => {
  const t = await tenant("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const again = await createWorkroom(actor, {
    projectId: t.projectId,
    title: "A second one",
    summary: "",
  });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "already_done");

  // And when the two presses land together.
  const other = await createProject(actor, {
    clientId: t.clientId,
    name: "Another project",
    status: "planned",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(other.ok);

  const [a, b] = await Promise.all([
    createWorkroom(actor, { projectId: other.value, title: "One", summary: "" }),
    createWorkroom(actor, { projectId: other.value, title: "Two", summary: "" }),
  ]);
  assert.equal([a, b].filter((r) => r.ok).length, 1, "exactly one may win");
  assert.equal(
    (await db().select().from(workrooms).where(sql`project_id = ${other.value}`)).length,
    1,
  );
});

test("the URL identifier says nothing about the work behind it", async () => {
  const t = await tenant("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const room = await findWorkroom(t.workroomId);

  assert.ok(isPublicId(room!.publicId));
  assert.equal(room!.publicId.length, 26);
  assert.notEqual(room!.publicId, room!.id, "never the UUIDv7, whose first bits are a timestamp");
  for (const word of ["alder", "rebrand", "co"]) {
    assert.ok(!room!.publicId.includes(word), `the id must not contain ${word}`);
  }
});

test("a draft is invisible, publishing opens it, unpublishing closes it again", async () => {
  const t = await tenant("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  // A draft cannot even be invited into: a link into one would not work.
  const early = await inviteToWorkroom(actor, { workroomId: t.workroomId, contactId: t.contactId });
  assert.equal(early.ok, false);
  assert.equal(early.ok === false && early.reason, "blocked");

  const draft = await findWorkroom(t.workroomId);
  assert.ok((await publishWorkroom(actor, t.workroomId, draft!.version)).ok);
  const identityId = await joined(t);

  assert.ok(await workroomForViewer(t.contactId, (await findWorkroom(t.workroomId))!.publicId));
  assert.equal((await workroomsForViewer(t.contactId)).length, 1);
  assert.equal(await canSignIn("ana@alder.test"), true);

  const live = await findWorkroom(t.workroomId);
  assert.ok((await unpublishWorkroom(actor, t.workroomId, live!.version)).ok);

  // Everything about the person survives; only the door closes.
  assert.equal(await workroomForViewer(t.contactId, live!.publicId), null);
  assert.deepEqual(await workroomsForViewer(t.contactId), []);
  assert.equal(await canSignIn("ana@alder.test"), false, "nothing to sign in to");
  assert.equal((await listWorkroomMembers(t.workroomId))[0]?.status, "active");
  assert.ok(identityId);
});

test("a published workroom cannot be archived out from under its members", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const room = await findWorkroom(t.workroomId);
  const blocked = await archiveWorkroom(actor, t.workroomId, room!.version);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.reason, "blocked");

  assert.ok((await unpublishWorkroom(actor, t.workroomId, room!.version)).ok);
  const closed = await findWorkroom(t.workroomId);
  assert.ok((await archiveWorkroom(actor, t.workroomId, closed!.version)).ok);
});

test("a stale edit of a workroom is refused, and the first one survives", async () => {
  const t = await tenant("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const { updateWorkroom } = await import("../lib/db/workrooms.ts");

  assert.ok((await updateWorkroom(actor, t.workroomId, { title: "First", summary: "" }, 1)).ok);

  const late = await updateWorkroom(actor, t.workroomId, { title: "Second", summary: "" }, 1);
  assert.equal(late.ok, false);
  assert.equal(late.ok === false && late.reason, "conflict");
  assert.equal((await findWorkroom(t.workroomId))?.title, "First");
});

/* ------------------------------------------------------------ invitations */

test("reading an invitation does not consume it; accepting does, once", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const token = await invite(t);

  // However many times it is looked at.
  for (let i = 0; i < 3; i++) {
    const preview = await inspectWorkroomInvitation(token);
    assert.ok(preview.ok);
    assert.equal(preview.preview.email, "ana@alder.test");
  }
  assert.equal(
    (await db().select().from(workroomInvitations).where(sql`accepted_at IS NOT NULL`)).length,
    0,
    "a scanner opening the link must not spend it",
  );

  const first = await acceptWorkroomInvitation({ token, name: "Ana Alder" });
  assert.ok(first.ok);

  const second = await acceptWorkroomInvitation({ token, name: "Ana Alder" });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "already_used");
});

test("two tabs accepting at the same moment produce one person and one membership", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const token = await invite(t);

  const [a, b] = await Promise.all([
    acceptWorkroomInvitation({ token, name: "Ana Alder" }),
    acceptWorkroomInvitation({ token, name: "Ana Alder" }),
  ]);

  assert.equal([a, b].filter((r) => r.ok).length, 1, "exactly one may win");

  // Every table the winning path writes to, not only the primary record:
  // Build 003 was caught by a losing transaction leaving a contact behind.
  assert.deepEqual(await sideEffects(), {
    identities: 1,
    members: 1,
    accepted: 1,
    invitations: 1,
    joinedActivity: 1,
    // Plus the `workroom.opened` line publishing wrote. The client's timeline
    // gains one entry from this, not two.
    activity: 2,
    auditIdentityCreated: 1,
    auditAccepted: 1,
    auditInvited: 1,
  });

  // And the loser was told why, rather than handed a half-built world.
  const loser = [a, b].find((r) => !r.ok)!;
  assert.equal(loser.ok === false && loser.reason, "already_used");
});

test("the same person joining two workrooms at once gets one identity and both", async () => {
  // Two projects for one client, two invitations, accepted in the same moment.
  // The identity is created by whichever transaction gets there first and
  // reused by the other, so the interesting number is 1 and not 2.
  const first = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const second = await createProject(actor, {
    clientId: first.clientId,
    name: "Alder & Co signage",
    status: "active",
    description: "MARKER-PROJECT-DESCRIPTION-A2",
    notes: "MARKER-PROJECT-NOTE-A2",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(second.ok);
  const room = await createWorkroom(actor, {
    projectId: second.value,
    title: "Alder & Co signage",
    summary: "A second private space, same person.",
  });
  assert.ok(room.ok);
  const made = await findWorkroom(room.value);
  assert.ok((await publishWorkroom(actor, room.value, made!.version)).ok);

  const tokens = await Promise.all([
    invite(first),
    invite({ ...first, workroomId: room.value }),
  ]);

  const results = await Promise.all(
    tokens.map((token) => acceptWorkroomInvitation({ token, name: "Ana Alder" })),
  );
  assert.equal(results.filter((r) => r.ok).length, 2, "these do not compete");
  assert.equal(new Set(results.map((r) => (r.ok ? r.identityId : ""))).size, 1, "one person");

  assert.deepEqual(await sideEffects(), {
    identities: 1,
    members: 2,
    accepted: 2,
    invitations: 2,
    joinedActivity: 2,
    activity: 4, // two `workroom.opened` from publishing, two joins.
    auditIdentityCreated: 1,
    auditAccepted: 2,
    auditInvited: 2,
  });
});

test("a failure at the very last write undoes everything before it", async () => {
  // Audit and activity are written last, inside the same transaction as the
  // data. That is easy to believe and worth proving, so the last write is made
  // to fail and everything earlier is counted afterwards: the invitation must
  // still be unspent, with no identity and no membership behind it.
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const token = await invite(t);

  await db().execute(
    sql`ALTER TABLE workroom_activity ADD CONSTRAINT tmp_no_joins CHECK (kind <> 'workroom.joined')`,
  );
  try {
    await assert.rejects(() => acceptWorkroomInvitation({ token, name: "Ana Alder" }));
  } finally {
    await db().execute(sql`ALTER TABLE workroom_activity DROP CONSTRAINT tmp_no_joins`);
  }

  const counts = await sideEffects();
  assert.equal(counts.identities, 0, "an identity survived a failed acceptance");
  assert.equal(counts.members, 0);
  assert.equal(counts.accepted, 0, "the invitation was spent on a failure");
  assert.equal(counts.joinedActivity, 0);
  assert.equal(counts.auditIdentityCreated, 0, "audit is inside the transaction, not beside it");
  assert.equal(counts.auditAccepted, 0);

  // And the link still works, which is the point of rolling back rather than
  // failing halfway.
  assert.ok((await acceptWorkroomInvitation({ token, name: "Ana Alder" })).ok);
});

test("an acceptance racing its own revocation leaves no half state", async () => {
  // Whichever order PostgreSQL settles on, there is never a membership without
  // an accepted invitation behind it, and never an identity without a
  // membership.
  for (let run = 0; run < 5; run++) {
    await wipe();
    const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
    const token = await invite(t);
    const open = (await db().select().from(workroomInvitations))[0]!;

    const [accepted, revoked] = await Promise.all([
      acceptWorkroomInvitation({ token, name: "Ana Alder" }),
      revokeWorkroomInvitation(actor, open.id),
    ]);

    const counts = await sideEffects();
    if (accepted.ok) {
      assert.deepEqual(
        {
          identities: counts.identities,
          members: counts.members,
          accepted: counts.accepted,
          joinedActivity: counts.joinedActivity,
          auditAccepted: counts.auditAccepted,
        },
        { identities: 1, members: 1, accepted: 1, joinedActivity: 1, auditAccepted: 1 },
        `run ${run}: accepted`,
      );
    } else {
      assert.ok(revoked.ok, `run ${run}: one of the two must have happened`);
      assert.deepEqual(
        {
          identities: counts.identities,
          members: counts.members,
          accepted: counts.accepted,
          joinedActivity: counts.joinedActivity,
          auditAccepted: counts.auditAccepted,
        },
        { identities: 0, members: 0, accepted: 0, joinedActivity: 0, auditAccepted: 0 },
        `run ${run}: refused`,
      );
    }
  }
});

test("two simultaneous invitations to the same person produce one", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const [a, b] = await Promise.all([
    inviteToWorkroom(actor, { workroomId: t.workroomId, contactId: t.contactId }),
    inviteToWorkroom(actor, { workroomId: t.workroomId, contactId: t.contactId }),
  ]);

  assert.equal([a, b].filter((r) => r.ok).length, 1);

  // The loser wrote nothing: not a second row, not a second audit line, and
  // above all not a second live token for the same person.
  const counts = await sideEffects();
  assert.equal(counts.invitations, 1);
  assert.equal(counts.auditInvited, 1);
  assert.equal(counts.accepted, 0);
  assert.equal(counts.members, 0);
  assert.equal(counts.identities, 0);
  assert.equal(counts.joinedActivity, 0, "an invitation is not yet news for the client");
  assert.equal(counts.activity, 1, "only the line publishing wrote");
});

test("resending replaces the old link, and the old one stops working", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const first = await invite(t);

  const open = (await db().select().from(workroomInvitations).where(sql`revoked_at IS NULL`))[0]!;
  const resent = await resendWorkroomInvitation(actor, open.id);
  assert.ok(resent.ok);
  assert.notEqual(resent.value.token, first);

  const stale = await inspectWorkroomInvitation(first);
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.reason, "revoked");

  assert.ok((await acceptWorkroomInvitation({ token: resent.value.token, name: "" })).ok);
});

test("an invitation revoked while somebody is looking at it cannot be accepted", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const token = await invite(t);

  const open = (await db().select().from(workroomInvitations))[0]!;
  assert.ok(await inspectWorkroomInvitation(token));
  assert.ok((await revokeWorkroomInvitation(actor, open.id)).ok);

  const late = await acceptWorkroomInvitation({ token, name: "" });
  assert.equal(late.ok, false);
  assert.equal((await db().select().from(clientIdentity)).length, 0, "and nobody was created");
  assert.equal((await db().select().from(workroomMembers)).length, 0);
});

test("an expired invitation is refused", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const token = await invite(t);
  const later = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);

  const checked = await inspectWorkroomInvitation(token, later);
  assert.equal(checked.ok, false);
  assert.equal(checked.ok === false && checked.reason, "expired");
  assert.equal((await acceptWorkroomInvitation({ token, name: "" }, later)).ok, false);
});

test("only people already connected to the client or project can be invited", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const outsider = await createContact(actor, {
    name: "Nobody Relevant",
    email: "nobody@elsewhere.test",
    emailNormalized: "nobody@elsewhere.test",
    phone: null,
    title: null,
    notes: "",
  });
  assert.ok(outsider.ok);

  const offered = (await invitableContacts(t.workroomId)).map((person) => person.name);
  assert.deepEqual(offered, ["Ana Alder"]);
  assert.ok(!offered.includes("Nobody Relevant"));
});

test("somebody with no email cannot be invited, and is told why", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const silent = await createContact(actor, {
    name: "No Address",
    email: null,
    emailNormalized: null,
    phone: "+1 555 0100",
    title: null,
    notes: "",
  });
  assert.ok(silent.ok);
  assert.ok(
    (await attachContactToClient(actor, {
      clientId: t.clientId,
      contactId: silent.value,
      role: null,
      isPrimary: false,
    })).ok,
  );

  assert.ok(!(await invitableContacts(t.workroomId)).some((p) => p.name === "No Address"));

  const refused = await inviteToWorkroom(actor, {
    workroomId: t.workroomId,
    contactId: silent.value,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.ok === false ? refused.message : "", /no email address/);
});

/* --------------------------------------------------------------- identity */

test("one person, one identity, however many workrooms they are invited to", async () => {
  const a = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  // The same person, on a second project for the same client.
  const second = await createProject(actor, {
    clientId: a.clientId,
    name: "Alder & Co website",
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(second.ok);
  const room = await createWorkroom(actor, {
    projectId: second.value,
    title: "Alder & Co website",
    summary: "",
  });
  assert.ok(room.ok);
  const draft = await findWorkroom(room.value);
  assert.ok((await publishWorkroom(actor, room.value, draft!.version)).ok);

  const firstIdentity = await joined(a);
  const secondIdentity = await joined({ ...a, workroomId: room.value });

  assert.equal(firstIdentity, secondIdentity, "never a second account per project");
  assert.equal((await db().select().from(clientIdentity)).length, 1);
  assert.equal((await workroomsForViewer(a.contactId)).length, 2);
});

test("two Contacts sharing one address cannot both hold access to it", async () => {
  // `contacts` does not make email unique, deliberately: a shared inbox is a
  // real thing and so are duplicate rows. A client identity's email is a
  // credential and is unique, so the second person to accept cannot be given
  // one — and must be refused in a way somebody can act on, not crashed.
  const t = await published("A", "Alder & Co", "Ana Alder", "office@alder.test");
  assert.ok(await joined(t));

  const twin = await createContact(actor, {
    name: "Alder Front Desk",
    email: "office@alder.test",
    emailNormalized: "office@alder.test",
    phone: null,
    title: "Office",
    notes: "MARKER-CONTACT-NOTE-TWIN",
  });
  assert.ok(twin.ok);
  assert.ok(
    (await attachContactToClient(actor, {
      clientId: t.clientId,
      contactId: twin.value,
      role: "Reception",
      isPrimary: false,
    })).ok,
  );

  const issued = await inviteToWorkroom(actor, {
    workroomId: t.workroomId,
    contactId: twin.value,
  });
  assert.ok(issued.ok, "the studio may still send it; the collision is not visible here");

  const accepted = await acceptWorkroomInvitation({ token: issued.value.token, name: "" });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.ok === false && accepted.reason, "unavailable");

  // And the refusal rolled everything back: one identity, one membership, and
  // the second invitation still unaccepted rather than spent.
  const counts = await sideEffects();
  assert.equal(counts.identities, 1);
  assert.equal(counts.members, 1);
  assert.equal(counts.accepted, 1);
  assert.equal(counts.invitations, 2);
  assert.equal(counts.auditIdentityCreated, 1);
});

test("an edit to a contact's email never moves their access", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  await joined(t);

  const { updateContact } = await import("../lib/db/contacts.ts");
  const before = await findContact(t.contactId);
  assert.ok(
    (await updateContact(
      actor,
      t.contactId,
      {
        name: "Ana Alder",
        email: "somebody-else@elsewhere.test",
        emailNormalized: "somebody-else@elsewhere.test",
        phone: null,
        title: null,
        notes: "",
      },
      before!.version,
    )).ok,
  );

  const [identity] = await db().select().from(clientIdentity);
  assert.equal(identity!.email, "ana@alder.test", "the verified credential is untouched");
  assert.equal(await canSignIn("ana@alder.test"), true);
  assert.equal(await canSignIn("somebody-else@elsewhere.test"), false);
});

test("switching an identity off stops sign-in everywhere, and back on restores it", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const identityId = await joined(t);

  assert.ok((await setIdentityStatus(actor, identityId, "inactive")).ok);
  assert.equal(await canSignIn("ana@alder.test"), false);

  assert.ok((await setIdentityStatus(actor, identityId, "active")).ok);
  assert.equal(await canSignIn("ana@alder.test"), true);
});

/* ------------------------------------------------------------- membership */

test("revoking access is immediate, and giving it back does not need a new invitation", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  await joined(t);
  const room = await findWorkroom(t.workroomId);

  const member = (await listWorkroomMembers(t.workroomId))[0]!;
  assert.ok((await revokeMembership(actor, member.id, member.version)).ok);

  assert.equal(await workroomForViewer(t.contactId, room!.publicId), null);
  assert.deepEqual(await workroomsForViewer(t.contactId), []);
  assert.equal(await canSignIn("ana@alder.test"), false);

  const revoked = (await listWorkroomMembers(t.workroomId))[0]!;
  assert.equal(revoked.status, "revoked");
  assert.ok((await restoreMembership(actor, revoked.id, revoked.version)).ok);
  assert.ok(await workroomForViewer(t.contactId, room!.publicId));

  // One row throughout: the history is in the audit log, not in duplicates.
  assert.equal((await db().select().from(workroomMembers)).length, 1);
});

test("losing one workroom does not lose the other", async () => {
  const a = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const second = await createProject(actor, {
    clientId: a.clientId,
    name: "Alder & Co website",
    status: "active",
    description: "",
    notes: "",
    ownerId: null,
    startsOn: null,
    targetOn: null,
  });
  assert.ok(second.ok);
  const room = await createWorkroom(actor, { projectId: second.value, title: "Website", summary: "" });
  assert.ok(room.ok);
  const draft = await findWorkroom(room.value);
  assert.ok((await publishWorkroom(actor, room.value, draft!.version)).ok);

  await joined(a);
  await joined({ ...a, workroomId: room.value });
  assert.equal((await workroomsForViewer(a.contactId)).length, 2);

  const member = (await listWorkroomMembers(a.workroomId))[0]!;
  assert.ok((await revokeMembership(actor, member.id, member.version)).ok);

  const left = await workroomsForViewer(a.contactId);
  assert.equal(left.length, 1);
  assert.equal(left[0]?.title, "Website");
  assert.equal(await canSignIn("ana@alder.test"), true, "they still have somewhere to go");
});

/* --------------------------------------------------------------- lifecycle */

test("a contact with live access cannot be archived away", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  // A second person, deliberately not the primary contact, so this isolates
  // Build 004's guard from the Build 003 one that would otherwise fire first.
  const second = await createContact(actor, {
    name: "Sam Second",
    email: "sam@alder.test",
    emailNormalized: "sam@alder.test",
    phone: null,
    title: null,
    notes: "",
  });
  assert.ok(second.ok);
  assert.ok(
    (await attachContactToClient(actor, {
      clientId: t.clientId,
      contactId: second.value,
      role: "Approvals",
      isPrimary: false,
    })).ok,
  );
  await joined({ ...t, contactId: second.value });

  const contact = await findContact(second.value);
  const blocked = await archiveContact(actor, second.value, contact!.version);
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok === false ? blocked.message : "", /still has access/);

  const member = (await listWorkroomMembers(t.workroomId)).find((m) => m.contactId === second.value)!;
  assert.ok((await revokeMembership(actor, member.id, member.version)).ok);
  assert.ok((await archiveContact(actor, second.value, contact!.version)).ok);
});

test("a project with an open workroom cannot be archived", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");

  const project = await findProject(t.projectId);
  assert.ok(
    (await updateProject(
      actor,
      t.projectId,
      {
        name: project!.name,
        status: "completed",
        description: "",
        notes: "",
        ownerId: null,
        startsOn: null,
        targetOn: null,
      },
      project!.version,
    )).ok,
  );

  const completed = await findProject(t.projectId);
  const blocked = await archiveProject(actor, t.projectId, completed!.version);
  assert.equal(blocked.ok, false);
  assert.match(blocked.ok === false ? blocked.message : "", /open to its members/);
});

test("finishing a project does not close the client's workroom", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  await joined(t);
  const room = await findWorkroom(t.workroomId);
  const project = await findProject(t.projectId);

  assert.ok(
    (await updateProject(
      actor,
      t.projectId,
      {
        name: project!.name,
        status: "completed",
        description: "",
        notes: "",
        ownerId: null,
        startsOn: null,
        targetOn: null,
      },
      project!.version,
    )).ok,
  );

  assert.ok(
    await workroomForViewer(t.contactId, room!.publicId),
    "the moment work finishes is when a client goes back to look at it",
  );
});

/* ---------------------------------------------------- what a client is given */

test("nothing internal reaches the client projection", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  await joined(t);
  const room = (await workroomForViewer(t.contactId, (await findWorkroom(t.workroomId))!.publicId))!;

  const view = toClientWorkroomView(room, { startsOn: "2026-08-01", targetOn: "2026-12-01" });
  const serialized = JSON.stringify(view);

  for (const marker of MARKERS) {
    assert.ok(!serialized.includes(marker), `${marker} reached the client view`);
  }
  // Not even the internal ids.
  assert.ok(!serialized.includes(room.id));
  assert.ok(!serialized.includes(room.projectId));
  assert.ok(!serialized.includes(t.clientId));
  assert.equal(view.id, room.publicId);
  assert.equal(view.status, "Active", "a word, not the enum value");
});

test("activity is written for a client, and carries no vocabulary or metadata", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  await joined(t);

  const project = await findProject(t.projectId);
  assert.ok(
    (await updateProject(
      actor,
      t.projectId,
      {
        name: project!.name,
        status: "on_hold",
        description: "MARKER-PROJECT-DESCRIPTION-A",
        notes: "MARKER-PROJECT-NOTE-A",
        ownerId: null,
        startsOn: null,
        targetOn: null,
      },
      project!.version,
    )).ok,
  );

  const rows = await listActivity(t.workroomId);
  assert.deepEqual(
    rows.map((row) => row.kind).sort(),
    ["project.status_changed", "workroom.joined", "workroom.opened"],
  );

  const text = toClientActivity(rows).map((item) => item.text);
  assert.ok(text.includes("Status changed to On hold"));
  assert.ok(text.includes("Ana Alder joined"));
  assert.ok(text.includes("Workroom opened"));

  const serialized = JSON.stringify(rows);
  for (const marker of MARKERS) assert.ok(!serialized.includes(marker));
  // And it never says who inside the studio changed anything.
  assert.ok(!serialized.includes("Test Owner"));
});

test("audit and activity record the same event differently, and neither reads the other", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  await clearAudit();
  await joined(t);

  const audit = (await listAuditEvents()).rows;
  const activity = await listActivity(t.workroomId);

  // Audit knows it was the client, by a column that is not the staff one.
  const accepted = audit.find((event) => event.action === "workroom_invitation.accepted");
  assert.ok(accepted);
  assert.equal(accepted.actorKind, "client_user");

  // Activity holds the same moment with none of that.
  const joinedEvent = activity.find((row) => row.kind === "workroom.joined");
  assert.ok(joinedEvent);
  assert.equal(joinedEvent.actorLabel, "Ana Alder");
  assert.ok(!("metadata" in joinedEvent), "activity has nowhere to put one");

  // A staff event stays a staff event.
  const staffEvents = audit.filter((event) => event.actorKind === "team_user");
  assert.ok(staffEvents.length === 0 || staffEvents.every((event) => event.actorName === "Test Owner"));
});

test("history makes its actors undeletable, which is stronger than the schema says", async () => {
  const t = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const identityId = await joined(t);

  // The foreign key says ON DELETE SET NULL. The append-only trigger refuses
  // that UPDATE, so the delete fails instead — an actor cannot be erased from
  // the record of what they did. Worth knowing, and worth keeping.
  await assert.rejects(
    () => db().execute(sql`DELETE FROM client_identities WHERE id = ${identityId}`),
    (error: Error) => /append-only/.test(chain(error)),
  );

  assert.equal((await db().select().from(clientIdentity)).length, 1);
});

/** Drizzle wraps driver errors, so what PostgreSQL said lives down the chain. */
function chain(error: unknown): string {
  const seen: string[] = [];
  let current: unknown = error;
  for (let i = 0; current instanceof Error && i < 5; i++) {
    seen.push(current.message);
    current = (current as Error & { cause?: unknown }).cause;
  }
  return seen.join(" | ");
}

/* --------------------------------------------------------- tenant isolation */

test("one client's viewer can reach nothing of another's", async () => {
  const a = await published("A", "Alder & Co", "Ana Alder", "ana@alder.test");
  const b = await published("B", "Birch Group", "Ben Birch", "ben@birch.test");
  await joined(a);
  await joined(b);

  const roomA = (await findWorkroom(a.workroomId))!;
  const roomB = (await findWorkroom(b.workroomId))!;

  assert.ok(await workroomForViewer(a.contactId, roomA.publicId));
  assert.equal(await workroomForViewer(a.contactId, roomB.publicId), null);
  assert.ok(await workroomForViewer(b.contactId, roomB.publicId));
  assert.equal(await workroomForViewer(b.contactId, roomA.publicId), null);

  assert.deepEqual((await workroomsForViewer(a.contactId)).map((r) => r.title), ["Alder & Co rebrand"]);
  assert.deepEqual((await workroomsForViewer(b.contactId)).map((r) => r.title), ["Birch Group rebrand"]);

  // A workroom that never existed answers exactly as somebody else's does.
  assert.equal(await workroomForViewer(a.contactId, "00000000000000000000000000"), null);
});
