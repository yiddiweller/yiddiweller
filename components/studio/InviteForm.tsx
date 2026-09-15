"use client";

import { useActionState, useId } from "react";

import { inviteStaff, type ActionResult } from "@/app/studio/(app)/team/actions";
import styles from "@/app/studio/studio.module.css";

export default function InviteForm() {
  const [result, action, pending] = useActionState<ActionResult | null, FormData>(
    inviteStaff,
    null,
  );
  const id = useId();

  return (
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
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-role`}>
          Role
        </label>
        <select id={`${id}-role`} name="role" defaultValue="member" className={styles.select}>
          <option value="member">Member</option>
          <option value="owner">Owner</option>
        </select>
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={pending}>
          {pending ? "Sending" : "Send invitation"}
        </button>
        <p
          className={`${styles.status} ${result && !result.ok ? styles.statusError : ""}`}
          role="status"
          aria-live="polite"
        >
          {result?.message ?? ""}
        </p>
      </div>
    </form>
  );
}
