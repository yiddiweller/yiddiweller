"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { signOut } from "@/lib/client-auth/client";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * Leaving. Ends the client session and nothing else — a Studio session on the
 * same browser is a different cookie on a different host and is untouched.
 */
export default function SignOut() {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      className={styles.quiet}
      disabled={pending}
      onClick={() =>
        start(async () => {
          await signOut();
          router.replace("/workrooms/login");
          router.refresh();
        })
      }
    >
      {pending ? "Signing out" : "Sign out"}
    </button>
  );
}
