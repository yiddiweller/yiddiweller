"use client";

import { useTransition } from "react";

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
  confirm?: string;
}) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      className={styles.buttonQuiet}
      disabled={pending}
      onClick={() => {
        if (confirm && !window.confirm(confirm)) return;
        start(() => void action(id));
      }}
    >
      {pending ? busyLabel : label}
    </button>
  );
}
