/**
 * What a Review form is allowed to say.
 *
 * A server action is a public endpoint. Everything below assumes the caller is
 * hostile and the form is whatever they decided to send, so each reader names
 * the exact shape it accepts and returns `null` for anything else. **Nothing
 * here coerces.** `Number("")` is `0`, `Number(null)` is `0`, and a silent
 * coercion is how a blank field becomes ordinal zero or item zero.
 *
 * The two handles a Review surface uses are deliberately not identifiers:
 *
 *   `n`      a note's ordinal within the round the caller is already authorized for
 *   `item`   a Revision item's position
 *
 * Both are small positive integers scoped to something already proven. A UUID
 * arriving where one of these belongs is refused rather than looked up — there
 * is no path from a form to a database id anywhere in this layer.
 */

/** A positive integer, written as a decimal integer and nothing else. */
function positiveInteger(value: FormDataEntryValue | null | undefined): number | null {
  if (typeof value !== "string") return null;
  // Anchored, so `1e3`, `0x10`, ` 1 `, `1.0`, `+1`, `1abc` and a UUID all fail
  // before `Number` ever sees them.
  if (!/^[1-9][0-9]{0,8}$/.test(value)) return null;
  return Number(value);
}

/** The ordinal of a note inside its round. One-based, never zero. */
export function readOrdinal(value: FormDataEntryValue | null | undefined): number | null {
  return positiveInteger(value);
}

/** A Revision number, one-based. */
export function readRevisionNumber(value: FormDataEntryValue | null | undefined): number | null {
  return positiveInteger(value);
}

/**
 * A Revision item's position. **Zero-based**, because that is what the
 * Presentation projection has always used — hence its own reader rather than
 * reusing the one above and getting the first item wrong.
 */
export function readItemPosition(value: FormDataEntryValue | null | undefined): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (!/^(0|[1-9][0-9]{0,8})$/.test(value)) return null;
  return Number(value);
}

export const BODY_MAX = 8000;

/** What somebody wrote. Trimmed, bounded, and never silently truncated. */
export function readBody(value: FormDataEntryValue | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > BODY_MAX) return null;
  return trimmed;
}

/**
 * The anchor, as a JSON string in the form.
 *
 * Parsed to a plain object and no further: the exact shape is
 * `parseAnchor`'s in `lib/db/reviews.ts`, which validates against the item's
 * own viewer kind — a question this layer cannot answer, because it has not
 * read the item yet. So this refuses only what could never be an anchor at all,
 * and hands the rest to the one place that knows.
 *
 * `undefined` means the form said nothing, which is the ordinary case. `null`
 * means it said something that is not an object, which is a refusal.
 */
export function readAnchor(value: FormDataEntryValue | null | undefined): unknown | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") return null;
  if (value.trim().length === 0) return undefined;
  // A whole anchor is a handful of numbers; anything long is not one, and
  // parsing it would be work done on an attacker's behalf.
  if (value.length > 400) return null;

  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
