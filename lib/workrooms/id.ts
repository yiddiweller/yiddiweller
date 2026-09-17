import { randomBytes } from "node:crypto";

/**
 * The identifier a Workroom is reached by.
 *
 * Not the row's UUIDv7. A v7 carries the millisecond it was created in its
 * first 48 bits, so a client-facing URL built from one quietly announces when a
 * piece of work began — and a URL is the part of a private space that gets
 * forwarded, pasted into a calendar invitation and read over somebody's
 * shoulder.
 *
 * 16 random bytes, written in Crockford's base32: no vowels, so it cannot
 * spell anything; no `i`, `l`, `o` or `u`, so it cannot be misread or
 * mistranscribed; lowercase, because it sits in a URL. 128 bits of randomness
 * in 26 characters.
 *
 * **It is not authorization.** Every read behind it checks membership on the
 * server. Unguessability only means a link cannot be found by accident; a
 * forwarded one still gets whoever opens it a sign-in page.
 */

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export const PUBLIC_ID_LENGTH = 26;

export function workroomPublicId(): string {
  const bytes = randomBytes(16);

  // Streamed five bits at a time rather than through a BigInt, so `value`
  // never holds more than twelve bits and the arithmetic stays exact.
  let value = 0;
  let bits = 0;
  let out = "";

  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfffff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  // 128 bits do not divide by five; the last three are padded with zeroes.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];

  return out;
}

/**
 * The same generator, for anything else that needs a client-facing address.
 *
 * Build 005's Files and Presentations are reached by one of these too, and for
 * the same reasons: a UUIDv7 would announce when the row was created, and a
 * name would announce whose it is. Aliased rather than copied so there is one
 * alphabet and one length in the codebase.
 */
export const opaquePublicId = workroomPublicId;

/** Rejects a malformed id before it reaches a query, so a bad one is a 404. */
export function isPublicId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === PUBLIC_ID_LENGTH &&
    [...value].every((char) => ALPHABET.includes(char))
  );
}
