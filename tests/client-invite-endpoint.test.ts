import assert from "node:assert/strict";
import { after, test } from "node:test";

import { inArray } from "drizzle-orm";

import { type AuditActor } from "../lib/db/audit.ts";
import { createClient } from "../lib/db/clients.ts";
import { attachContactToClient, createContact } from "../lib/db/contacts.ts";
import { db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import { createProject } from "../lib/db/projects.ts";
import {
  acceptWorkroomInvitation,
  createWorkroom,
  findWorkroom,
  inspectWorkroomInvitation,
  inviteToWorkroom,
  listWorkroomMembers,
  publishWorkroom,
  resendWorkroomInvitation,
} from "../lib/db/workrooms.ts";
import {
  clientIdentity,
  clientRateLimit,
  projectContacts,
  projects,
  user,
  workroomActivity,
  workroomInvitations,
  workroomMembers,
  workrooms,
} from "../lib/db/schema.ts";

/**
 * The acceptance **endpoint**, over HTTP.
 *
 * This file exists because of two rounds of beta investigation into a client
 * who could not get in. Everything about invitations was tested at the domain
 * layer and nothing had ever driven the endpoint itself — so the layers in
 * front of and after `acceptWorkroomInvitation` were, between them, the only
 * untested part of the one journey that matters most to somebody outside the
 * company.
 *
 * Three layers can refuse a tap, and they must be distinguishable:
 *
 *   the rate limiter   in front of the handler, 429, consumes nothing
 *   the acceptance     a business refusal, with its reason in `code`
 *   the session write  after the transaction committed, so access is real
 *
 * Needs a deployment running against **this same database**:
 *
 *   INVITE_SERVER_URL=http://localhost:3101 DATABASE_URL=… npm test
 */

const base = process.env.INVITE_SERVER_URL;
const skip = base ? false : "set INVITE_SERVER_URL to a server sharing this DATABASE_URL";

const actor: AuditActor = { id: uuidv7(), name: "Endpoint Owner" };
let ownerReady = false;

/** Every Client this file creates, so it can take them all away again. */
const created: string[] = [];

async function owner(): Promise<AuditActor> {
  if (!ownerReady) {
    await db()
      .insert(user)
      .values({
        id: actor.id,
        name: actor.name,
        email: `endpoint-${actor.id}@example.test`,
        role: "owner",
      })
      .onConflictDoNothing();
    ownerReady = true;
  }
  return actor;
}

/**
 * Workrooms and Projects removed, and deliberately nothing else.
 *
 * This file shares a database with the rest of the suite, and
 * `business-core.test.ts` predates Workrooms: its own wipe does not clear them,
 * and `projects.client_id` is `ON DELETE restrict`, so a Project left here
 * makes thirty-five unrelated tests fail. Learned in Stage A and written down
 * in docs/restore-rehearsal.md.
 *
 * Contacts, Clients and client identities are left alone on purpose. That wipe
 * already handles the first two, and an identity **cannot** be deleted at all:
 * `audit_events.client_actor_id` is `ON DELETE SET NULL` and the append-only
 * trigger refuses that UPDATE, so history makes its actors undeletable. That is
 * the product working, and a test is not the place to argue with it.
 */
after(async () => {
  if (created.length === 0) return;

  const ours = await db()
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.clientId, created));
  const projectIds = ours.map((row) => row.id);
  if (projectIds.length === 0) return;

  const rooms = await db()
    .select({ id: workrooms.id })
    .from(workrooms)
    .where(inArray(workrooms.projectId, projectIds));
  const roomIds = rooms.map((row) => row.id);

  if (roomIds.length > 0) {
    await db().delete(workroomInvitations).where(inArray(workroomInvitations.workroomId, roomIds));
    await db().delete(workroomMembers).where(inArray(workroomMembers.workroomId, roomIds));
    await db().delete(workroomActivity).where(inArray(workroomActivity.workroomId, roomIds));
    await db().delete(workrooms).where(inArray(workrooms.id, roomIds));
  }

  await db().delete(projectContacts).where(inArray(projectContacts.projectId, projectIds));
  await db().delete(projects).where(inArray(projects.id, projectIds));
  await db().delete(clientRateLimit);
});

function unwrap<T>(outcome: { ok: true; value: T } | { ok: false; message: string }, what: string): T {
  assert.ok(outcome.ok, outcome.ok ? "" : `${what}: ${outcome.message}`);
  return outcome.value;
}

/**
 * A tenant with its own everything, named so two runs never collide. Built
 * through the domain rather than by hand, so the state under test is the state
 * the product actually creates.
 */
async function tenant(tag: string) {
  const who = await owner();
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `${tag}-${stamp}@example.test`;

  const clientId = unwrap(
    await createClient(who, {
      accountType: "organization",
      name: `Endpoint ${tag} ${stamp}`,
      website: null,
      domain: null,
      status: "active",
      notes: "",
    }),
    "client",
  );
  const contactId = unwrap(
    await createContact(who, {
      name: `Person ${tag}`,
      email,
      emailNormalized: email,
      phone: null,
      title: null,
      notes: "",
    }),
    "contact",
  );
  unwrap(
    await attachContactToClient(who, { clientId, contactId, role: null, isPrimary: true }),
    "attach",
  );

  created.push(clientId);
  return { clientId, contactId, email, stamp };
}

async function room(clientId: string, tag: string) {
  const who = await owner();
  const projectId = unwrap(
    await createProject(who, {
      clientId,
      name: `Project ${tag} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      status: "active",
      description: "",
      notes: "",
      ownerId: null,
      startsOn: null,
      targetOn: null,
    }),
    "project",
  );
  const id = unwrap(await createWorkroom(who, { projectId, title: `Room ${tag}`, summary: "" }), "workroom");
  unwrap(await publishWorkroom(who, id, (await findWorkroom(id))!.version), "publish");
  return (await findWorkroom(id))!;
}

async function issue(workroomId: string, contactId: string) {
  return unwrap(await inviteToWorkroom(await owner(), { workroomId, contactId }), "invite");
}

/** The limiter keys on path and address, so it is cleared before counting taps. */
async function clearLimiter(): Promise<void> {
  await db().delete(clientRateLimit);
}

async function tap(token: string, name = "Person") {
  const response = await fetch(`${base}/api/client-auth/workroom-invitation/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name }),
    redirect: "manual",
  });

  const text = await response.text();
  let code = "";
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
  } catch {
    // A 429 from the limiter is not this endpoint's JSON.
  }

  return {
    status: response.status,
    code,
    cookie: response.headers.get("set-cookie") ?? "",
    body: text,
    workroom: (() => {
      try {
        return (JSON.parse(text) as { workroom?: string }).workroom ?? "";
      } catch {
        return "";
      }
    })(),
  };
}

/* ------------------------------------------------------------ the journey */

test("the whole tap, on the state beta failed in", { skip }, async () => {
  await clearLimiter();
  const t = await tenant("journey");

  // Build 004: they joined once already, so an identity, a membership and a
  // session row exist before any of this. One visible Contact, as Studio shows.
  const historical = await room(t.clientId, "historical");
  const before = await acceptWorkroomInvitation({
    token: (await issue(historical.id, t.contactId)).token,
    name: "Person journey",
  });
  assert.ok(before.ok, before.ok ? "" : before.reason);

  // Build 005: a new Workroom and a fresh invitation to that same Contact.
  const current = await room(t.clientId, "current");
  const invite = await issue(current.id, t.contactId);

  // The landing read, twice — it is a GET and a scanner may have been first.
  for (const attempt of [1, 2]) {
    const page = await fetch(`${base}/workrooms/invite/${invite.token}`, { redirect: "manual" });
    assert.equal(page.status, 200, `landing read ${attempt}`);
    assert.match(await page.text(), /Open my workroom/, `landing read ${attempt} had no button`);
  }
  assert.equal(
    (await inspectWorkroomInvitation(invite.token)).ok,
    true,
    "reading the landing page consumed the invitation",
  );

  // The tap.
  const accepted = await tap(invite.token, "Person journey");
  assert.equal(accepted.status, 200, `the tap answered ${accepted.status}: ${accepted.body}`);
  assert.equal(accepted.workroom, current.publicId);

  // A session was issued, and it is the client instance's own cookie.
  assert.match(accepted.cookie, /yw_client\.session_token=/, "no client session cookie was set");
  assert.ok(!accepted.cookie.includes("yw_studio"), "a staff cookie was set");
  assert.match(accepted.cookie, /HttpOnly/i);
  assert.match(accepted.cookie, /SameSite=Lax/i);

  // And it works: the Workroom opens with it and nothing else.
  const token = /(?:^|[; ])((?:__Secure-)?yw_client\.session_token=[^;]+)/.exec(accepted.cookie)?.[1];
  assert.ok(token, "the cookie could not be read back");
  const opened = await fetch(`${base}/workrooms/${current.publicId}`, {
    headers: { cookie: token },
    redirect: "manual",
  });
  assert.equal(opened.status, 200, "the session it issued could not open the workroom");

  // One identity for this person, not a second.
  const identities = await db()
    .select({ id: clientIdentity.id })
    .from(clientIdentity)
    .where(inArray(clientIdentity.contactId, [t.contactId]));
  assert.equal(identities.length, 1, "a second identity was created");
  assert.equal(identities[0]!.id, before.identityId, "the existing identity was not reused");

  // Membership is live.
  assert.deepEqual(
    (await listWorkroomMembers(current.id)).map((m) => m.status),
    ["active"],
  );

  // Spent, once and for ever, and the second tap says exactly which refusal.
  const again = await tap(invite.token, "Person journey");
  assert.equal(again.status, 400);
  assert.equal(again.code, "ALREADY_USED");
  assert.deepEqual(
    (await listWorkroomMembers(current.id)).map((m) => m.status),
    ["active"],
    "a second tap changed the membership",
  );
});

/* ------------------------------------------- the three layers, told apart */

test("too many taps answers 429 and consumes nothing", { skip }, async () => {
  await clearLimiter();
  const t = await tenant("limit");
  const target = await room(t.clientId, "limit");
  const invite = await issue(target.id, t.contactId);

  // A person whose first tap failed taps again, and again. Every attempt costs
  // one — including the failures — so this is exactly what a confused person
  // does to themselves, and it is why the limiter must not be reported as a
  // dead invitation.
  let limited = 0;
  let allowed = 0;
  for (let i = 0; i < 14; i++) {
    const result = await tap(`0`.repeat(64));
    if (result.status === 429) limited++;
    else allowed++;
  }

  assert.ok(limited > 0, "the limiter never fired");
  assert.ok(allowed > 0, "the limiter fired immediately");

  // The invitation somebody actually holds is untouched by all of it.
  const look = await inspectWorkroomInvitation(invite.token);
  assert.equal(look.ok, true, "a rate-limited tap consumed an unrelated invitation");

  // And a 429 is not a 400: the two must not be told to a person as one thing.
  const refused = await tap(`0`.repeat(64));
  assert.equal(refused.status, 429);
  assert.equal(refused.code, "", "a limiter response carried a business refusal code");

  // Once the window is cleared, the held invitation still opens.
  await clearLimiter();
  const accepted = await tap(invite.token, "Person limit");
  assert.equal(accepted.status, 200, `after the window: ${accepted.body}`);
});

test("every business refusal arrives with its own reason", { skip }, async () => {
  await clearLimiter();
  const t = await tenant("reasons");
  const target = await room(t.clientId, "reasons");

  // Never real.
  assert.equal((await tap("not-a-token")).code, "INVALID");

  // Revoked by a resend, which is what a client holding the older email has.
  const first = await issue(target.id, t.contactId);
  const second = unwrap(await resendWorkroomInvitation(await owner(), first.id), "resend");
  const stale = await tap(first.token, "Person reasons");
  assert.equal(stale.status, 400);
  assert.equal(stale.code, "REVOKED", "a superseded link was reported as something else");

  // And the newest one opens.
  const fresh = await tap(second.token, "Person reasons");
  assert.equal(fresh.status, 200, fresh.body);
  assert.equal(fresh.workroom, target.publicId);
});

test("a token grants only what it was issued for", { skip }, async () => {
  await clearLimiter();
  const a = await tenant("iso-a");
  const b = await tenant("iso-b");
  const roomA = await room(a.clientId, "iso-a");
  const roomB = await room(b.clientId, "iso-b");

  const forA = await issue(roomA.id, a.contactId);
  const accepted = await tap(forA.token, "Whoever");
  assert.equal(accepted.status, 200, accepted.body);
  assert.equal(accepted.workroom, roomA.publicId, "it granted the wrong workroom");

  // Nothing of B's moved, and B's own invitation is untouched.
  assert.deepEqual((await listWorkroomMembers(roomB.id)).map((m) => m.status), []);
  const forB = await issue(roomB.id, b.contactId);
  assert.equal((await inspectWorkroomInvitation(forB.token)).ok, true);

  // A's session cannot open B's Workroom.
  const token = /(?:^|[; ])((?:__Secure-)?yw_client\.session_token=[^;]+)/.exec(accepted.cookie)?.[1];
  assert.ok(token);
  const trespass = await fetch(`${base}/workrooms/${roomB.publicId}`, {
    headers: { cookie: token },
    redirect: "manual",
  });
  assert.equal(trespass.status, 404, `A's session got ${trespass.status} on B's workroom`);
});

/* --------------------------------------------- what the person is told */

test("the page tells the three layers apart, not just the server", async () => {
  // The server distinguishing them is only half of it: the component used to
  // print one sentence whatever came back, which is what made two rounds of
  // investigation necessary. Asserted against the source because the mapping
  // is the thing that regressed, and it has no server to be driven through.
  const { readFileSync } = await import("node:fs");
  const component = readFileSync("components/workrooms/AcceptInvitation.tsx", "utf8");

  assert.match(component, /response\.status === 429/, "a rate-limited tap is not told apart");
  assert.match(component, /Too many attempts/, "a rate-limited tap has no honest message");
  assert.match(component, /session_failed/, "a failed session write is not told apart");
  assert.match(component, /Your access is ready/, "a failed session write has no honest message");
  assert.match(component, /INVITATION_FAILURE\[reason\]/, "business refusals are not told apart");

  // And the sentence that used to be the only answer is now only the fallback.
  const generic = component.indexOf("That invitation cannot be used");
  assert.ok(generic > component.indexOf("if (!reason)"), "the generic message is not the fallback");
});
