"use client";

import { useActionState, useId } from "react";

import { signIn } from "@/lib/client-auth/client";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * Requesting a sign-in link.
 *
 * **One answer for every address.** Known, unknown, disabled, or holding no
 * current access — all four produce the same sentence, because any difference
 * between them tells whoever typed it whether that person works with us. The
 * server decides whether mail is actually sent, and says nothing about it.
 *
 * The request goes to the client auth instance's own base path, so it can never
 * be answered by Studio's.
 */
export default function SignInForm() {
  const id = useId();

  const [sent, submit, pending] = useActionState<boolean, FormData>(async (_was, form) => {
    const email = String(form.get("email") ?? "").trim();
    if (!email) return false;

    await signIn.magicLink({ email, callbackURL: "/workrooms" });
    return true;
  }, false);

  if (sent) {
    return (
      <>
        <p className={styles.entranceNote}>
          If that address has a workroom, a link is on its way. It opens once and lasts fifteen
          minutes.
        </p>
        <p className={styles.status}>You can close this page.</p>
      </>
    );
  }

  return (
    <form action={submit} className={styles.form}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-email`}>
          Email
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          maxLength={254}
          autoFocus
          className={styles.input}
        />
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={pending}>
          {pending ? "Sending" : "Send me a link"}
        </button>
      </div>
    </form>
  );
}
