"use client";

import { useActionState, useId } from "react";

import { acceptStaffInvitation, type JoinResult } from "@/app/studio/join/actions";
import SignInForm from "@/components/studio/SignInForm";
import { INVITATION_FAILURE } from "@/components/studio/invitationCopy";
import styles from "@/app/studio/studio.module.css";

/**
 * Asks for one thing: the name this person should be known by inside Studio.
 * The email is fixed by the invitation and is not an input, so accepting a link
 * cannot grant access to an address nobody invited.
 */
export default function JoinForm({ token, email }: { token: string; email: string }) {
  const [result, action, pending] = useActionState<JoinResult | null, FormData>(
    acceptStaffInvitation,
    null,
  );
  const id = useId();

  if (result?.ok) {
    return (
      <div>
        <p className={styles.loginTitle}>You are on the team.</p>
        <p className={styles.loginNote}>
          One more step. Studio has no password — send yourself a sign-in link to finish.
        </p>
        <SignInForm defaultEmail={result.email} />
      </div>
    );
  }

  // The invitation stopped being usable between loading the page and submitting
  // it, which is the whole reason the server checks again.
  if (result && result.reason !== "name") {
    const copy = INVITATION_FAILURE[result.reason];
    return (
      <div role="status">
        <p className={styles.loginTitle}>{copy.title}</p>
        <p className={styles.loginNote}>{copy.note}</p>
        <a className={styles.buttonQuiet} href="/studio/login">
          Go to sign in
        </a>
      </div>
    );
  }

  return (
    <form action={action} className={styles.form}>
      <input type="hidden" name="token" value={token} />

      <div className={styles.field}>
        <span className={styles.label}>Email</span>
        <p className={styles.status}>{email}</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-name`}>
          Your name
        </label>
        <input
          id={`${id}-name`}
          name="name"
          type="text"
          autoComplete="name"
          autoFocus
          required
          minLength={2}
          maxLength={120}
          className={styles.input}
        />
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={pending}>
          {pending ? "Setting up" : "Accept invitation"}
        </button>
        <p
          className={`${styles.status} ${styles.statusError}`}
          role="status"
          aria-live="polite"
        >
          {result?.ok === false && result.reason === "name"
            ? "Please enter your name."
            : ""}
        </p>
      </div>
    </form>
  );
}
