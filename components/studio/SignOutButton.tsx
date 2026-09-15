"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "@/lib/auth/client";
import styles from "@/app/studio/studio.module.css";

export default function SignOutButton({ quiet = false }: { quiet?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      className={quiet ? styles.buttonQuiet : styles.button}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await authClient.signOut();
        router.replace("/studio/login");
        router.refresh();
      }}
    >
      {busy ? "Signing out" : "Sign out"}
    </button>
  );
}
