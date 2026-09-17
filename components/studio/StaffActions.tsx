"use client";

import { useState, useTransition } from "react";

import ConfirmDialog, { type Confirm } from "@/components/studio/ConfirmDialog";
import styles from "@/app/studio/studio.module.css";

/**
 * A button that calls one Owner-only server action. Kept deliberately dumb:
 * the authorization that matters happens inside the action, on the server.
 *
 * `confirm` is asked for the actions somebody would not want to fire by
 * accident — removing access, revoking a live invitation. Destructive actions
 * are marked by a question and by their words, not by being red.
 */
export default function StaffAction({
  action,
  id,
  label,
  busyLabel,
  confirm,
}: {
  action: (id: string) => Promise<void>;
  id: string;
  label: string;
  busyLabel: string;
  confirm?: Confirm;
}) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);

  // The dialog stays up, saying so, until the action returns — so a second
  // press has nowhere to land and nobody is left wondering whether it worked.
  const run = () =>
    start(async () => {
      await action(id);
      setAsking(false);
    });

  return (
    <>
      <button
        type="button"
        className={styles.buttonQuiet}
        disabled={pending}
        onClick={confirm ? () => setAsking(true) : run}
      >
        {pending ? busyLabel : label}
      </button>

      {confirm ? (
        <ConfirmDialog
          confirm={confirm}
          open={asking}
          pending={pending}
          onCancel={() => setAsking(false)}
          onConfirm={run}
        />
      ) : null}
    </>
  );
}
