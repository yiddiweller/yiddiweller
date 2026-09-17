"use client";

import { useEffect, useId, useRef } from "react";

import styles from "@/app/studio/studio.module.css";

/**
 * What a confirmation says.
 *
 * Three parts, and none of them generic. **A title that names the action, a
 * sentence about what changes, and a button that repeats the verb** — so the
 * last thing somebody reads before committing is the thing they are about to
 * do, not the word "OK". A browser's own confirm can only offer one line and
 * two anonymous buttons, which is most of why it was worth replacing.
 */
export type Confirm = {
  /** A question naming the action. "Publish presentation?" */
  title: string;
  /** One sentence on the consequence. Optional where there genuinely is none. */
  message?: string;
  /** The button's words. Never "OK", never "Yes". */
  action: string;
  /**
   * Losing something, ending access, or taking something away from a client.
   *
   * It changes emphasis, not colour: the palette is black and white, so a
   * destructive confirmation is shown as an outlined button rather than the
   * solid one a constructive action gets. Less inviting, deliberately, and
   * legible to somebody who cannot see a red button as red.
   */
  destructive?: boolean;
};

/**
 * One confirmation dialog for the whole of Studio.
 *
 * Native `<dialog>` with `showModal()`, exactly as `FormDialog` is: the focus
 * trap, the inert background, Escape and returning focus to the trigger are the
 * platform's, and reimplementing them in React is how each of those quietly
 * stops working.
 *
 * Two shapes of caller, one component. `RecordAction` submits a real form, so
 * its confirm button is the form's submit button and lives inside the form.
 * `StaffAction` calls a function, so its confirm button is an ordinary button.
 * The difference is one prop rather than two dialogs.
 */
export default function ConfirmDialog({
  confirm,
  open,
  pending,
  onCancel,
  onConfirm,
  submit = false,
}: {
  confirm: Confirm;
  open: boolean;
  /** The mutation is in flight: both buttons lock and Escape stops working. */
  pending: boolean;
  onCancel: () => void;
  onConfirm?: () => void;
  /** True when the action button is the enclosing form's submit button. */
  submit?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={`${id}-title`}
      aria-describedby={confirm.message ? `${id}-note` : undefined}
      /* Escape while the mutation is in flight would say "cancelled" about
         something already happening. Every other moment it cancels. */
      onCancel={(event) => {
        if (pending) event.preventDefault();
      }}
      onClose={onCancel}
    >
      <div className={styles.dialogHead}>
        <h2 className={styles.dialogTitle} id={`${id}-title`}>
          {confirm.title}
        </h2>
        {confirm.message ? (
          <p className={styles.dialogNote} id={`${id}-note`}>
            {confirm.message}
          </p>
        ) : null}
      </div>

      <div className={styles.actions}>
        {/* Cancel takes focus, so the keyboard's first Enter is the safe one.
            It is second in the visual order and first in intent. */}
        <button
          type="button"
          className={styles.buttonQuiet}
          onClick={onCancel}
          disabled={pending}
          autoFocus
        >
          Cancel
        </button>

        <button
          type={submit ? "submit" : "button"}
          className={confirm.destructive ? styles.buttonSecondary : styles.button}
          onClick={submit ? undefined : onConfirm}
          disabled={pending}
        >
          {pending ? "Working…" : confirm.action}
        </button>
      </div>
    </dialog>
  );
}
