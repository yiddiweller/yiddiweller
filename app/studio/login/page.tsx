import SignInForm from "@/components/studio/SignInForm";
import SignOutButton from "@/components/studio/SignOutButton";
import StudioMark from "@/components/studio/StudioMark";
import { currentStaff, sessionEmail } from "@/lib/auth/guard";
import { redirect } from "next/navigation";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Sign in" };

/**
 * The private entrance.
 *
 * It has four states, and all four are designed rather than left to whatever
 * the framework does: the door, the link on its way, a link that did not work,
 * and an account that no longer has access. The last one matters most — a
 * removed member holds a perfectly valid session, so without it they would see
 * an empty form for ever and never learn why.
 */
export default async function StudioLogin({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // Already signed in and still active: no reason to look at a sign-in form.
  if (await currentStaff()) redirect("/studio");

  const [{ error }, signedInAs] = await Promise.all([searchParams, sessionEmail()]);

  // A session, but not an active staff record: access was removed, or was
  // never granted to that address.
  if (signedInAs) {
    return (
      <main className={`${styles.tokens} ${styles.entrance}`}>
        <StudioMark className={styles.entranceMark} />
        <h1 className={styles.entranceTitle}>This account no longer has access.</h1>
        <p className={styles.entranceNote}>
          {signedInAs} is signed in, but Studio access for it has ended. An Owner can restore it.
        </p>
        <div className={styles.actions}>
          <SignOutButton />
        </div>
      </main>
    );
  }

  return (
    <main className={`${styles.tokens} ${styles.entrance}`}>
      <StudioMark className={styles.entranceMark} />
      <h1 className={styles.entranceTitle}>Sign in.</h1>
      <p className={styles.entranceNote}>
        Studio is for the Yiddi Weller team. We send a link rather than asking for a password.
      </p>

      {error ? (
        <div className={styles.notice} role="status">
          <p className={styles.noticeTitle}>That link did not work.</p>
          <p>
            A sign-in link works once and expires after ten minutes. Ask for a new one below.
          </p>
        </div>
      ) : null}

      <SignInForm />
    </main>
  );
}
