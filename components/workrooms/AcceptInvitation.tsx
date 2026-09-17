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
 * Three layers can refuse this and they used to be indistinguishable — one
 * sentence for all of them, which cost two rounds of beta investigation. Each
 * now says the thing that is actually true, because the right next step differs
 * completely between them:
 *
 * **Too many attempts.** The limiter sits in front of the endpoint and answers
 * 429. Nothing is wrong with the invitation and nothing has been consumed, so
 * the honest advice is to wait — and being told "this invitation cannot be
 * used" is what makes somebody keep tapping, which is what keeps it spent.
 *
 * **The acceptance was refused.** The endpoint reports which refusal, and the
 * same copy the landing page would have shown is used. A sign-in link is sound
 * advice for an expired link and wrong for the two about the client identity,
 * where it would fail the same way.
 *
 * **The acceptance worked and signing in did not.** Their access is real and
 * already granted; only the session failed. A sign-in link genuinely works
 * here, which is the opposite of what a refusal needs.
 */
async function explain(response: Response): Promise<string> {
  if (response.status === 429) {
    return "Too many attempts in a short time. Wait a few minutes and open the most recent email again — there is nothing wrong with your invitation.";
  }

  const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code.toLowerCase() : "";

  if (code === "session_failed") {
    return "Your access is ready, but signing you in did not finish. Ask for a sign-in link and it will let you straight in.";
  }

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
