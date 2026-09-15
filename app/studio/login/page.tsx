import { redirect } from "next/navigation";

import SignInForm from "@/components/studio/SignInForm";
import StudioMark from "@/components/studio/StudioMark";
import { currentStaff } from "@/lib/auth/guard";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Sign in" };

export default async function StudioLogin() {
  // Already signed in: no reason to look at a sign-in form.
  if (await currentStaff()) redirect("/studio");

  return (
    <main className={styles.login}>
      <StudioMark className={styles.loginMark} />
      <h1 className={styles.loginTitle}>Sign in.</h1>
      <p className={styles.loginNote}>Studio is for the Yiddi Weller team.</p>
      <SignInForm />
    </main>
  );
}
