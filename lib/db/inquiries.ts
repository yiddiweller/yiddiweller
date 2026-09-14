import { createHash } from "node:crypto";

import { eq } from "drizzle-orm";

import { db } from "./index.ts";
import { uuidv7 } from "./id.ts";
import { inquiries, type InquirySource } from "./schema.ts";

/**
 * Everything the application does with inquiries. Route handlers call these
 * functions; they never build queries themselves, so the shape of the table
 * stays changeable from one place.
 */

export type InquiryInput = {
  name: string;
  email: string;
  message: string;
  source?: InquirySource;
};

export type RecordedInquiry = {
  id: string;
  /** True when this exact message was already stored moments ago. */
  duplicate: boolean;
};

/**
 * Width of the window in which an identical resubmission is treated as the
 * same inquiry. Ten minutes is long enough to absorb a double submit or a
 * client retry, and short enough that someone deliberately sending the same
 * message again later is still recorded.
 */
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Identifies one logical submission. Hashed rather than stored in the clear so
 * the index does not become a second copy of the message body.
 *
 * Known limitation: two requests either side of a window boundary produce
 * different keys and both are stored. That yields one duplicate row in a rare
 * race, which is the behaviour without deduplication at all, so the boundary
 * costs nothing it does not already save elsewhere.
 */
export function dedupeKey(
  email: string,
  message: string,
  now: number = Date.now(),
): string {
  const bucket = Math.floor(now / DEDUPE_WINDOW_MS);
  return createHash("sha256")
    .update(`${email.toLowerCase()}\n${message}\n${bucket}`)
    .digest("hex");
}

/** Trims, and lowercases the address, so stored values are consistent. */
export function normalizeInquiry(input: InquiryInput): Required<InquiryInput> {
  return {
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    message: input.message.trim(),
    source: input.source ?? "website_contact",
  };
}

/**
 * Persists an inquiry, collapsing an accidental resubmission into the existing
 * row. Uniqueness is resolved by the database rather than by reading first,
 * so two simultaneous requests cannot both decide they are the original.
 */
export async function recordInquiry(
  input: InquiryInput,
  now: number = Date.now(),
): Promise<RecordedInquiry> {
  const fields = normalizeInquiry(input);
  const key = dedupeKey(fields.email, fields.message, now);

  const inserted = await db()
    .insert(inquiries)
    .values({
      id: uuidv7(now),
      name: fields.name,
      email: fields.email,
      message: fields.message,
      source: fields.source,
      status: "new",
      dedupeKey: key,
    })
    .onConflictDoNothing({ target: inquiries.dedupeKey })
    .returning({ id: inquiries.id });

  if (inserted.length > 0) {
    return { id: inserted[0].id, duplicate: false };
  }

  const existing = await db()
    .select({ id: inquiries.id })
    .from(inquiries)
    .where(eq(inquiries.dedupeKey, key))
    .limit(1);

  return { id: existing[0]?.id ?? "", duplicate: true };
}
