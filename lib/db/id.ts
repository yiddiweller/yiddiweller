import { randomBytes } from "node:crypto";

/**
 * UUIDv7 (RFC 9562): a 48-bit big-endian millisecond timestamp followed by
 * 74 random bits, with the version and variant fields set.
 *
 * Chosen over a serial integer because a sequential key in a public or
 * client-facing URL leaks how much business has passed through the table and
 * invites enumeration. Chosen over UUIDv4 because the leading timestamp keeps
 * newly inserted rows adjacent in the primary key index, which preserves
 * insert locality as tables grow.
 *
 * Generated in the application rather than by the database so that a record's
 * identity is known before the INSERT, which later phases need in order to
 * reference a row across tables inside one transaction.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ms = Math.floor(now);

  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reads the embedded timestamp back out. Used by tests and future tooling. */
export function uuidv7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
