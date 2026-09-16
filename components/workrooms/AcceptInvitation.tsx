"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId } from "react";

import styles from "@/app/workrooms/workroom.module.css";

/**
 * Accepting. A POST, and the only thing that consumes an invitation.
 *
 * The name field is prefilled from the Contact we already hold, so the ordinary
 * path is one button. Somebody can correct it — it is their name — and it goes
 * to their client identity, not back into the business record.
 */
export default function AcceptInvitation({ token, name }: { token: string; name: string }) {
  const router = useRouter();
  const id = useId();

  const [error, submit, pending] = useActionState<string | null, FormData>(
    async (_previous, form) => {
      const response = await fetch("/api/client-auth/workroom-invitation/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name: String(form.get("name") ?? "") }),
      });

      if (!response.ok) {
        return "That invitation cannot be used. Ask for a sign-in link, or reply to the email it came from.";
      }

      const result = (await response.json()) as { workroom?: string };
      router.replace(result.workroom ? `/workrooms/${result.workroom}` : "/workrooms");
      router.refresh();
      return null;
    },
    null,
  );

  return (
    <form action={submit} className={styles.form}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-name`}>
          Your name
        </label>
        <input
          id={`${id}-name`}
          name="name"
          defaultValue={name}
          maxLength={160}
          autoComplete="name"
          className={styles.input}
        />
      </div>

      <p className={styles.status} role="status" aria-live="polite">
        {error ?? ""}
      </p>

      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={pending}>
          {pending ? "Opening" : "Open my workroom"}
        </button>
      </div>
    </form>
  );
}
