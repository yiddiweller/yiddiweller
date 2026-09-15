"use client";

import { useId, useState } from "react";

import { authClient } from "@/lib/auth/client";
import styles from "@/app/studio/studio.module.css";

type State = "idle" | "sending" | "sent" | "error";

/**
 * Requests a magic link. The response is deliberately identical whether or not
 * the address belongs to a staff member, so this form cannot be used to
 * discover who works here.
 */
export default function SignInForm({ defaultEmail = "" }: { defaultEmail?: string }) {
  const [email, setEmail] = useState(defaultEmail);
  const [state, setState] = useState<State>("idle");
  const id = useId();

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state === "sending") return;

    const address = email.trim();
    if (!address) return;

    setState("sending");

    try {
      await authClient.signIn.magicLink({ email: address, callbackURL: "/studio" });
      setState("sent");
    } catch {
      // Never surfaces whether the address exists. A genuine transport failure
      // and an unknown address look the same from here on purpose.
      setState("sent");
    }
  }

  if (state === "sent") {
    return (
      <div role="status">
        <p className={styles.loginTitle}>Check your email.</p>
        <p className={styles.loginNote}>
          If that address has Studio access, a sign-in link is on its way. It expires in ten
          minutes.
        </p>
        <button type="button" className={styles.buttonQuiet} onClick={() => setState("idle")}>
          Use a different address
        </button>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={onSubmit} noValidate>
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
          autoFocus
          required
          maxLength={254}
          className={styles.input}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.button} disabled={state === "sending"}>
          {state === "sending" ? "Sending" : "Send sign-in link"}
        </button>
      </div>
    </form>
  );
}
