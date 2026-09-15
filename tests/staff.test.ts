import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { staffForEmail } from "../lib/auth/access.ts";
import { closeDb, db } from "../lib/db/index.ts";
import { uuidv7 } from "../lib/db/id.ts";
import {
  acceptInvitation,
  countOwners,
  createInvitation,
  findStaffByEmail,
  hashToken,
  inspectInvitation,
  listOpenInvitations,
  listStaff,
  revokeInvitation,
  setStaffStatus,
} from "../lib/db/staff.ts";
import { session, staffInvitations, user } from "../lib/db/schema.ts";

/**
 * Studio access control, at the layer that actually decides it.
 *
 * The invariant every one of these protects: a user row is created only by
 * accepting a valid invitation. Better Auth cannot create one, sign-up is
 * disabled, and nothing else in the application inserts into `user` except the
 * one-time owner bootstrap script.
 */

const DAY = 24 * 60 * 60 * 1000;

async function wipe() {
  await db().delete(session);
  await db().delete(staffInvitations);
  await db().delete(user);
}

/** An Owner to issue invitations, created directly because someone must exist first. */
async function seedOwner(email = "owner@example.com") {
  const id = uuidv7();
  await db()
    .insert(user)
    .values({ id, name: "Owner", email, emailVerified: true, role: "owner", status: "active" });
  return id;
}

before(wipe);
beforeEach(wipe);

after(async () => {
  await wipe();
  await closeDb();
});

// --------------------------------------------------------------- invitations

test("an invitation stores a digest, never the token", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "New@Example.com ", role: "member", invitedBy });

  const [row] = await db().select().from(staffInvitations);

  assert.equal(row.email, "new@example.com", "the address is normalised");
  assert.notEqual(row.tokenHash, token);
  assert.equal(row.tokenHash, hashToken(token));
  assert.ok(!JSON.stringify(row).includes(token), "the token appears nowhere in the row");
});

test("a valid invitation previews without consuming itself", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "new@example.com", role: "member", invitedBy });

  const first = await inspectInvitation(token);
  assert.deepEqual(first, { ok: true, email: "new@example.com", role: "member" });

  const second = await inspectInvitation(token);
  assert.deepEqual(second, first, "previewing twice changes nothing");

  const [row] = await db().select().from(staffInvitations);
  assert.equal(row.acceptedAt, null);
});

test("accepting an invitation is the only way a staff record appears", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "new@example.com", role: "member", invitedBy });

  const result = await acceptInvitation(token, "  Grace Hopper  ");
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.staff.name, "Grace Hopper");
  assert.equal(result.ok && result.staff.role, "member");
  assert.equal(result.ok && result.staff.status, "active");

  const [invite] = await db().select().from(staffInvitations);
  assert.notEqual(invite.acceptedAt, null, "the invitation is consumed");
  assert.equal((await listOpenInvitations()).length, 0);
  assert.equal((await listStaff()).length, 2);
});

test("an invitation is single use", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "new@example.com", role: "member", invitedBy });

  assert.equal((await acceptInvitation(token, "Grace")).ok, true);

  const again = await acceptInvitation(token, "Someone Else");
  assert.deepEqual(again, { ok: false, reason: "already_used" });
  assert.deepEqual(await inspectInvitation(token), { ok: false, reason: "already_used" });

  const rows = await db().select().from(user);
  assert.equal(rows.filter((r) => r.email === "new@example.com").length, 1);
});

test("two simultaneous acceptances create exactly one staff member", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "race@example.com", role: "member", invitedBy });

  const [a, b] = await Promise.allSettled([
    acceptInvitation(token, "First"),
    acceptInvitation(token, "Second"),
  ]);

  const outcomes = [a, b].map((r) => (r.status === "fulfilled" ? r.value.ok : false));
  assert.equal(outcomes.filter(Boolean).length, 1, "exactly one submission wins");

  const rows = await db().select().from(user);
  assert.equal(rows.filter((r) => r.email === "race@example.com").length, 1);
});

test("an expired invitation is refused", async () => {
  const invitedBy = await seedOwner();
  const past = new Date(Date.now() - 8 * DAY);
  const { token } = await createInvitation({
    email: "late@example.com",
    role: "member",
    invitedBy,
    now: past,
  });

  assert.deepEqual(await inspectInvitation(token), { ok: false, reason: "expired" });
  assert.deepEqual(await acceptInvitation(token, "Late"), { ok: false, reason: "expired" });
  assert.equal(await findStaffByEmail("late@example.com"), null);
});

test("a revoked invitation reveals nothing and admits nobody", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "gone@example.com", role: "member", invitedBy });
  const [invite] = await db().select().from(staffInvitations);

  await revokeInvitation(invite.id);

  // `invalid`, not a reason of its own: the holder of a withdrawn token learns
  // only that it does not work.
  assert.deepEqual(await inspectInvitation(token), { ok: false, reason: "invalid" });
  assert.deepEqual(await acceptInvitation(token, "Gone"), { ok: false, reason: "invalid" });
  assert.equal(await findStaffByEmail("gone@example.com"), null);
});

test("an unissued token is invalid", async () => {
  assert.deepEqual(await inspectInvitation("not-a-real-token"), { ok: false, reason: "invalid" });
  assert.deepEqual(await acceptInvitation("not-a-real-token", "Nobody"), {
    ok: false,
    reason: "invalid",
  });
  assert.equal((await listStaff()).length, 0, "no user row is created by a bad token");
});

test("an invitation to somebody who already has access is refused", async () => {
  const invitedBy = await seedOwner("owner@example.com");
  const { token } = await createInvitation({
    email: "owner@example.com",
    role: "member",
    invitedBy,
  });

  assert.deepEqual(await acceptInvitation(token, "Owner Again"), {
    ok: false,
    reason: "already_staff",
  });
  assert.equal((await listStaff()).length, 1);
});

test("only open invitations are listed, and expiry is reported", async () => {
  const invitedBy = await seedOwner();
  await createInvitation({ email: "open@example.com", role: "member", invitedBy });
  await createInvitation({
    email: "stale@example.com",
    role: "member",
    invitedBy,
    now: new Date(Date.now() - 8 * DAY),
  });

  const open = await listOpenInvitations();
  assert.equal(open.length, 2);
  assert.equal(open.find((i) => i.email === "open@example.com")?.expired, false);
  assert.equal(open.find((i) => i.email === "stale@example.com")?.expired, true);
});

// ------------------------------------------------------------- authorization

test("anonymous and unknown addresses are nobody", async () => {
  await seedOwner();
  assert.equal(await staffForEmail(null), null);
  assert.equal(await staffForEmail(undefined), null);
  assert.equal(await staffForEmail(""), null);
  assert.equal(await staffForEmail("stranger@example.com"), null);
});

test("an active member is recognised, with their own role", async () => {
  await seedOwner();
  const invitedBy = await seedOwner("second@example.com");
  const { token } = await createInvitation({ email: "member@example.com", role: "member", invitedBy });
  await acceptInvitation(token, "Member");

  const owner = await staffForEmail("owner@example.com");
  const member = await staffForEmail("member@example.com");

  assert.equal(owner?.role, "owner");
  assert.equal(member?.role, "member", "a member is admitted, but not as an Owner");
});

test("deactivating a member refuses them and ends their live sessions", async () => {
  const invitedBy = await seedOwner();
  const { token } = await createInvitation({ email: "member@example.com", role: "member", invitedBy });
  const accepted = await acceptInvitation(token, "Member");
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  await db().insert(session).values({
    id: uuidv7(),
    token: "session-token",
    expiresAt: new Date(Date.now() + DAY),
    userId: accepted.staff.id,
  });

  await setStaffStatus(accepted.staff.id, "inactive");

  assert.equal(await staffForEmail("member@example.com"), null, "refused on the next request");
  assert.equal((await db().select().from(session)).length, 0, "their sessions are gone");
  assert.notEqual(await findStaffByEmail("member@example.com"), null, "the person is not erased");

  await setStaffStatus(accepted.staff.id, "active");
  assert.notEqual(await staffForEmail("member@example.com"), null, "and can be restored");
});

test("owners are counted only while active", async () => {
  const id = await seedOwner();
  assert.equal(await countOwners(), 1);
  await setStaffStatus(id, "inactive");
  assert.equal(await countOwners(), 0);
});
