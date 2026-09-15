import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { and, desc, eq, isNull, sql } from "drizzle-orm";

import { db } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { staffInvitations, user, session, type StaffRole } from "./schema.ts";

/** Everything Studio does with staff records and invitations. */

export type Staff = {
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  status: "active" | "inactive";
  createdAt: Date;
};

export type Invitation = {
  id: string;
  email: string;
  role: StaffRole;
  expiresAt: Date;
  createdAt: Date;
  expired: boolean;
};

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Tokens are stored as a digest, so a database read yields no usable link. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function listStaff(): Promise<Staff[]> {
  const rows = await db()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    })
    .from(user)
    .orderBy(desc(user.createdAt));
  return rows as Staff[];
}

export async function findStaffByEmail(email: string): Promise<Staff | null> {
  const [row] = await db()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.email, email.trim().toLowerCase()))
    .limit(1);
  return (row as Staff | undefined) ?? null;
}

export async function countOwners(): Promise<number> {
  const [row] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(user)
    .where(and(eq(user.role, "owner"), eq(user.status, "active")));
  return row?.n ?? 0;
}

/** Open invitations only: accepted and revoked ones are history, not access. */
export async function listOpenInvitations(now: Date = new Date()): Promise<Invitation[]> {
  const rows = await db()
    .select({
      id: staffInvitations.id,
      email: staffInvitations.email,
      role: staffInvitations.role,
      expiresAt: staffInvitations.expiresAt,
      createdAt: staffInvitations.createdAt,
    })
    .from(staffInvitations)
    .where(and(isNull(staffInvitations.acceptedAt), isNull(staffInvitations.revokedAt)))
    .orderBy(desc(staffInvitations.createdAt));

  return rows.map((row) => ({ ...row, expired: row.expiresAt.getTime() <= now.getTime() }));
}

/**
 * Creates an invitation and returns the single-use token once. It is never
 * stored in the clear and cannot be recovered afterwards; a lost invitation is
 * revoked and reissued rather than looked up.
 */
export async function createInvitation(input: {
  email: string;
  role: StaffRole;
  invitedBy: string;
  now?: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const email = input.email.trim().toLowerCase();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  await db().insert(staffInvitations).values({
    id: uuidv7(now.getTime()),
    email,
    role: input.role,
    tokenHash: hashToken(token),
    invitedBy: input.invitedBy,
    expiresAt,
  });

  return { token, expiresAt };
}

export type InvitationFailure = "invalid" | "expired" | "already_used" | "already_staff";

export type AcceptResult = { ok: true; staff: Staff } | { ok: false; reason: InvitationFailure };

export type InvitationPreview =
  | { ok: true; email: string; role: StaffRole }
  | { ok: false; reason: InvitationFailure };

/**
 * Resolves a token to the invitation it stands for, or to the reason it is not
 * usable. A revoked invitation reports `invalid` rather than a distinct reason,
 * because the holder of a revoked token has no business learning that it once
 * existed.
 */
async function resolveInvitation(
  token: string,
  now: Date,
): Promise<
  { ok: true; invite: typeof staffInvitations.$inferSelect } | { ok: false; reason: InvitationFailure }
> {
  const digest = hashToken(token);

  const [invite] = await db()
    .select()
    .from(staffInvitations)
    .where(eq(staffInvitations.tokenHash, digest))
    .limit(1);

  if (!invite || !constantTimeEqual(invite.tokenHash, digest)) {
    return { ok: false, reason: "invalid" };
  }
  if (invite.revokedAt) return { ok: false, reason: "invalid" };
  if (invite.acceptedAt) return { ok: false, reason: "already_used" };
  if (invite.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };
  if (await findStaffByEmail(invite.email)) return { ok: false, reason: "already_staff" };

  return { ok: true, invite };
}

/**
 * Read-only check, so the acceptance page can say what is wrong before asking
 * someone to fill in a form. It writes nothing: a preview must never be able to
 * consume an invitation.
 */
export async function inspectInvitation(
  token: string,
  now: Date = new Date(),
): Promise<InvitationPreview> {
  const resolved = await resolveInvitation(token, now);
  if (!resolved.ok) return resolved;
  return { ok: true, email: resolved.invite.email, role: resolved.invite.role };
}

/**
 * Turns a valid invitation into an active staff record. This is the only path
 * that creates a user, which is what makes sign-up impossible: Better Auth
 * refuses to create one, and nothing else here does either.
 *
 * The checks run again here rather than trusting whatever the page displayed,
 * because the preview and the acceptance are two separate requests and the
 * invitation may have been revoked in between.
 */
export async function acceptInvitation(
  token: string,
  name: string,
  now: Date = new Date(),
): Promise<AcceptResult> {
  const resolved = await resolveInvitation(token, now);
  if (!resolved.ok) return resolved;
  const { invite } = resolved;

  const id = uuidv7(now.getTime());

  // One transaction, because a staff record without a consumed invitation is a
  // reusable link and a consumed invitation without a staff record locks the
  // person out. Claiming the row is conditional, so of two simultaneous
  // submissions of the same link exactly one proceeds to create a user.
  const created = await db().transaction(async (tx) => {
    const claimed = await tx
      .update(staffInvitations)
      .set({ acceptedAt: now })
      .where(and(eq(staffInvitations.id, invite.id), isNull(staffInvitations.acceptedAt)))
      .returning({ id: staffInvitations.id });

    if (claimed.length === 0) return false;

    await tx.insert(user).values({
      id,
      name: name.trim() || invite.email.split("@")[0],
      email: invite.email,
      emailVerified: true,
      role: invite.role,
      status: "active",
    });

    return true;
  });

  if (!created) return { ok: false, reason: "already_used" };

  const staff = await findStaffByEmail(invite.email);
  return staff ? { ok: true, staff } : { ok: false, reason: "invalid" };
}

export async function revokeInvitation(id: string, now: Date = new Date()): Promise<void> {
  await db()
    .update(staffInvitations)
    .set({ revokedAt: now })
    .where(and(eq(staffInvitations.id, id), isNull(staffInvitations.acceptedAt)));
}

/**
 * Revokes access without erasing the person. Historical references to them stay
 * intact, and their live sessions are deleted so the change takes effect now
 * rather than whenever a cookie happens to expire.
 */
export async function setStaffStatus(
  id: string,
  status: "active" | "inactive",
): Promise<void> {
  await db().update(user).set({ status }).where(eq(user.id, id));
  if (status === "inactive") {
    await db().delete(session).where(eq(session.userId, id));
  }
}
