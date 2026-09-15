/**
 * What a Studio form gets back.
 *
 * The domain layer answers in `Outcome` — ok, or a refusal with a reason a
 * person can act on. A form only needs the sentence, so this is the one place
 * the translation happens, and no page invents its own wording for a conflict.
 */

import { type Outcome } from "./db/outcome.ts";

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

export function succeeded(message: string): ActionResult {
  return { ok: true, message };
}

export function failed(message: string): ActionResult {
  return { ok: false, message };
}

/**
 * A refusal is not an error. `already_done` in particular is reported as
 * success, because from where somebody is standing the thing they asked for is
 * true — saying "no" to that is pedantry, not accuracy.
 */
export function fromOutcome<T>(outcome: Outcome<T>, message: string): ActionResult {
  if (outcome.ok) return succeeded(message);
  return outcome.reason === "already_done"
    ? succeeded(outcome.message)
    : failed(outcome.message);
}
