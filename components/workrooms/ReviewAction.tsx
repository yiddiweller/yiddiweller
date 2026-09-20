"use client";

import { useActionState, useState } from "react";

import ConfirmDialog, { type Confirm } from "@/components/studio/ConfirmDialog";
import { type ActionResult } from "@/lib/studio-result";
import styles from "@/components/workrooms/ReviewThread.module.css";

/**
 * One button inside a thread: resolve it, reopen it, take it back.
 *
 * It is `RecordAction` in shape and deliberately not `RecordAction` itself.
 * That component is built from Studio's `--s-*` tokens, which exist on a Studio
 * root and nowhere else, so rendering it in a Workroom would produce a button
 * with no padding, no height and no colour. The thread belongs to neither
 * world and carries its own stylesheet; this is the button that goes with it.
 *
 * **The confirmation is the shared one.** There is one `ConfirmDialog` for the
 * whole platform, on a native `<dialog>`, and its action button *is* this
 * form's submit button — so the dialog is not a gate in front of a mutation
 * that then happens by other means. Dismissing it submits nothing.
 *
 * Deliberately dumb. A server action is a public endpoint, and a button drawn
 * only for somebody who may press it protects nothing: the action re-reads the
 * caller, the round and the note under the round's row lock every time.
 */
export default function ReviewAction({
  action,
  fields,
  label,
  busyLabel,
  confirm,
  variant = "quiet",
}: {
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  fields: Record<string, string | number>;
  label: string;
  busyLabel: string;
  confirm?: Confirm;
  variant?: "primary" | "quiet";
}) {
  const [asking, setAsking] = useState(false);
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    // Closed by the submission that finished rather than by the click that
    // started it: while the action is in flight the dialog stays up with both
    // buttons locked, so a second press has no window to land in.
    async (previous, form) => {
      const outcome = await action(previous, form);
      setAsking(false);
      return outcome;
    },
    null,
  );

  return (
    <form action={submit}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <button
        type={confirm ? "button" : "submit"}
        className={variant === "primary" ? styles.button : styles.buttonQuiet}
        disabled={pending}
        onClick={confirm ? () => setAsking(true) : undefined}
      >
        {pending ? busyLabel : label}
      </button>

      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          open={asking}
          pending={pending}
          onCancel={() => setAsking(false)}
          submit
        />
      ) : null}

      {result && !result.ok ? (
        <span className={`${styles.status} ${styles.statusError}`} role="status">
          {result.message}
        </span>
      ) : null}
    </form>
  );
}
