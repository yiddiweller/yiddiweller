"use client";

import { useActionState } from "react";

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
  confirm?: string;
  variant?: "primary" | "secondary" | "quiet";
}) {
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(action, null);

  const className =
    variant === "primary" ? styles.button : variant === "secondary" ? styles.buttonSecondary : styles.buttonQuiet;

  return (
    <form
      action={submit}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}

      <button type="submit" className={className} disabled={pending}>
        {pending ? busyLabel : label}
      </button>

      {result && !result.ok ? (
        <span className={`${styles.status} ${styles.statusError}`} role="status">
          {result.message}
        </span>
      ) : null}
    </form>
  );
}
