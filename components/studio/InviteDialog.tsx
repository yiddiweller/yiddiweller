"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";

import { inviteStaff, type ActionResult } from "@/app/studio/(app)/team/actions";
import styles from "@/app/studio/studio.module.css";

/**
 * Inviting someone is occasional, so it is a dialog rather than a form sitting
 * permanently at the foot of the Team page taking up room that the roster
 * should have.
 *
 * Native <dialog> with showModal(): the focus trap, Escape, the inert
 * background and returning focus to the trigger are the platform's, not a
 * hand-rolled approximation. It closes itself once an invitation is away.
 */
export default function InviteDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // Wrapping the server action rather than watching its result in an effect:
  // the dialog closes as part of the submission that succeeded, which is where
  // that belongs, and there is no render pass showing a sent invitation inside
  // a dialog nobody is looking at any more.
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    async (previous, form) => {
      const outcome = await inviteStaff(previous, form);
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

  return (
    <>
      <button type="button" className={styles.button} onClick={() => setOpen(true)}>
        Invite someone
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
            Invite someone
          </h2>
          <p className={styles.dialogNote}>
            They receive a single-use link that expires in seven days. Nobody can sign in to
            Studio without one.
          </p>
        </div>

        <form action={action} className={styles.form}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-email`}>
              Email
            </label>
            <input
              id={`${id}-email`}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="off"
              required
              maxLength={254}
              className={styles.input}
              aria-describedby={result && !result.ok ? `${id}-error` : undefined}
            />
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${id}-role`}>
              Role
            </label>
            <select id={`${id}-role`} name="role" defaultValue="member" className={styles.select}>
              <option value="member">Member — sign in, see the team</option>
              <option value="owner">Owner — full access, can invite</option>
            </select>
          </div>

          <p
            className={`${styles.status} ${styles.statusError}`}
            id={`${id}-error`}
            role="status"
            aria-live="polite"
          >
            {result && !result.ok ? result.message : ""}
          </p>

          <div className={styles.actions}>
            <button type="submit" className={styles.button} disabled={pending}>
              {pending ? "Sending" : "Send invitation"}
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
