"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";

import { type ActionResult } from "@/lib/studio-result";
import styles from "@/app/studio/studio.module.css";

/**
 * A form that is only occasionally wanted — creating a record, editing one,
 * attaching somebody — behind the button that wants it.
 *
 * Native <dialog> with showModal(), like `InviteDialog`: the focus trap,
 * Escape, the inert background and returning focus to the trigger are the
 * platform's. The fields are passed in as children, so every one of these
 * dialogs shares its behaviour and none of them share a schema they would have
 * to be bent to fit.
 *
 * It closes as part of the submission that succeeded, rather than by watching
 * the result in an effect, so there is never a render showing a saved form
 * inside a dialog nobody is looking at any more.
 */
export default function FormDialog({
  trigger,
  title,
  note,
  submitLabel,
  busyLabel,
  action,
  children,
  variant = "primary",
}: {
  trigger: string;
  title: string;
  note?: string;
  submitLabel: string;
  busyLabel: string;
  action: (previous: ActionResult | null, form: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  variant?: "primary" | "secondary" | "quiet";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [result, submit, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, form) => {
      const outcome = await action(previous, form);
      if (outcome.ok) ref.current?.close();
      return outcome;
    },
    null,
  );
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const triggerClass =
    variant === "primary" ? styles.button : variant === "secondary" ? styles.buttonSecondary : styles.buttonQuiet;

  return (
    <>
      <button type="button" className={triggerClass} onClick={() => setOpen(true)}>
        {trigger}
      </button>

      {result?.ok ? (
        <p className={styles.status} role="status">
          {result.message}
        </p>
      ) : null}

      <dialog
        ref={ref}
        className={styles.dialog}
        aria-labelledby={`${id}-title`}
        onClose={() => setOpen(false)}
      >
        <div className={styles.dialogHead}>
          <h2 className={styles.dialogTitle} id={`${id}-title`}>
            {title}
          </h2>
          {note ? <p className={styles.dialogNote}>{note}</p> : null}
        </div>

        <form action={submit} className={styles.form}>
          {children}

          <p
            className={`${styles.status} ${styles.statusError}`}
            role="status"
            aria-live="polite"
          >
            {result && !result.ok ? result.message : ""}
          </p>

          <div className={styles.actions}>
            <button type="submit" className={styles.button} disabled={pending}>
              {pending ? busyLabel : submitLabel}
            </button>
            <button
              type="button"
              className={styles.buttonQuiet}
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
