"use client";

import { useRouter } from "next/navigation";
import { useActionState, useId } from "react";

import { INVITATION_FAILURE } from "@/components/workrooms/invitationCopy";
import { type InvitationFailure } from "@/lib/db/workrooms";
import styles from "@/app/workrooms/workroom.module.css";

/** The reasons the endpoint reports, as it reports them: the reason, upper-cased. */
const REASONS: InvitationFailure[] = [
  "invalid",
  "expired",
  "revoked",
  "already_used",
  "unavailable",
  "access_off",
  "email_taken",
];

/**
 * What a refused acceptance says.
 *
 * It used to say one thing for all of them — *ask for a sign-in link, or reply
 * to the email* — which is sound advice for an expired link and actively wrong
 * for the two that are about the client identity: a sign-in link would fail for
 * the same reason the acceptance did. So the endpoint's own reason is read and
 * the same copy the landing page would have shown is used, with the old
 * sentence kept for anything unrecognised.
 */
async function explain(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.toLowerCase() : "";
  const reason = REASONS.find((candidate) => candidate === code);

  if (!reason) {
    return "That invitation cannot be used. Ask for a sign-in link, or reply to the email it came from.";
  }

  const { title, note } = INVITATION_FAILURE[reason];
  return `${title} ${note}`;
}

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

      if (!response.ok) return explain(response);

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
