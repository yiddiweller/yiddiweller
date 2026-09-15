"use client";

import { useId, useState } from "react";

import { authClient } from "@/lib/auth/client";
import styles from "@/app/studio/studio.module.css";

type State = "idle" | "sending" | "sent";

/**
 * Requests a sign-in link.
 *
 * The response is deliberately identical whether or not the address belongs to
 * a staff member, so this form cannot be used to discover who works here. The
 * server holds up its end of that too: a link is only ever sent to an active
 * staff address, and the request succeeds either way.
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
      await authClient.signIn.magicLink({
        email: address,
        callbackURL: "/studio",
        // Without this a failed link lands on /studio, which sends anyone not
        // signed in back to this page and drops the reason on the way. Naming
        // the page here is what lets an expired link say so.
        errorCallbackURL: "/studio/login",
      });
    } catch {
      // A transport failure and an unknown address must look the same from
      // here. Saying "sent" either way is the point, not a shortcut.
    }

    setState("sent");
  }

  if (state === "sent") {
    return (
      <div role="status">
        <h2 className={styles.entranceTitle}>Check your email.</h2>
        <p className={styles.entranceNote}>
          If {email.trim()} has Studio access, a sign-in link is on its way. It works once and
          expires in ten minutes.
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
