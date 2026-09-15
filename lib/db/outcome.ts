/**
 * How a business operation reports what happened.
 *
 * Studio is multi-user software now, and the interesting outcomes are not
 * "threw" or "did not throw": a record may have been edited by somebody else
 * since this person loaded it, or an archive may be refused because it would
 * leave the data nonsensical. Both are ordinary, both need explaining calmly,
 * and neither is an exception.
 */

export type Refusal =
  /** Somebody else changed the record since it was loaded. */
  | "conflict"
  /** The operation would leave the data in a state we refuse to create. */
  | "blocked"
  /** It is not there, or the id was never valid. */
  | "not_found"
  /** The input did not pass validation the database would have rejected. */
  | "invalid"
  /** It has already happened, and happening twice would be wrong. */
  | "already_done";

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: Refusal; message: string };

export function ok<T>(value: T): Outcome<T> {
  return { ok: true, value };
}

export function refuse<T>(reason: Refusal, message: string): Outcome<T> {
  return { ok: false, reason, message };
}

/**
 * What a person is told when their edit lost a race. Not an apology, and not
 * an error code: what happened, and what to do about it.
 */
export const CONFLICT_MESSAGE =
  "Somebody else changed this record while you were editing. Reload to see their version, then make your change again.";

/**
 * Every update of a core record carries the `version` it was loaded with, and
 * applies only if the row still has it. Zero rows affected means somebody else
 * got there first — so nothing is written, rather than the later save silently
 * erasing the earlier one.
 *
 * The version is an integer rather than `updated_at` because the timestamp
 * cannot be compared honestly: Postgres keeps microseconds, a JavaScript
 * `Date` keeps milliseconds, and the value the application reads back is
 * therefore never the value the row holds. An integer survives the round trip
 * exactly. A database trigger raises it on every update, so this needs no help
 * from the caller beyond passing back what it read.
 */
export function expectUnchanged(rowsAffected: number): Outcome<void> {
  return rowsAffected > 0 ? ok(undefined) : refuse("conflict", CONFLICT_MESSAGE);
}
