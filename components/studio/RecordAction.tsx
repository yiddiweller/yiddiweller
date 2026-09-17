"use client";

import { useActionState, useState } from "react";

import ConfirmDialog, { type Confirm } from "@/components/studio/ConfirmDialog";
import { type ActionResult } from "@/lib/studio-result";
import styles from "@/app/studio/studio.module.css";

/**
 * One button that changes one record: archive it, restore it, move it a stage.
 *
 * It carries the version the page was rendered with, so a change composed
 * against a row somebody else has since edited is refused rather than quietly
 * overwriting them. The refusal is shown where the button is — a conflict is
 * ordinary, and being told about it next to the thing you pressed is the whole
 * value of catching it.
 *
 * Deliberately dumb: the authorization that matters happens inside the action,
 * on the server. A server action is a public endpoint, and a button that is
 * only rendered for an Owner protects nothing on its own.
 *
 * **`confirm` opens a real dialog inside this form**, and the dialog's action
 * button is the form's submit button. So the confirmation is not a gate in
 * front of a submission that then happens by other means — it *is* the
 * submission, carrying the same hidden fields, through the same server action.
 * There is no path where the dialog is dismissed and the mutation runs anyway.
 */
export default function RecordAction({
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
  variant?: "primary" | "secondary" | "quiet";
}) {
  const [asking, setAsking] = useState(false);
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    // Closed by the submission that finished, rather than by the click that
    // started it: while the action is in flight the dialog stays up saying so,
    // with both of its buttons locked, so there is no window in which a second
    // press can land. The same shape `FormDialog` uses.
    async (previous, form) => {
      const outcome = await action(previous, form);
      setAsking(false);
      return outcome;
    },
    null,
  );

  const className =
    variant === "primary" ? styles.button : variant === "secondary" ? styles.buttonSecondary : styles.buttonQuiet;

  return (
    <form action={submit}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <button
        type={confirm ? "button" : "submit"}
        className={className}
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
