"use client";

import { useTransition } from "react";

import styles from "@/app/studio/studio.module.css";

/**
 * A button that calls one owner-only server action. Kept deliberately dumb:
 * the authorization that matters happens inside the action, on the server.
 */
export default function StaffAction({
  action,
  id,
  label,
  busyLabel,
}: {
  action: (id: string) => Promise<void>;
  id: string;
  label: string;
  busyLabel: string;
}) {
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      className={styles.buttonQuiet}
      disabled={pending}
      onClick={() => start(() => void action(id))}
    >
      {pending ? busyLabel : label}
    </button>
  );
}
