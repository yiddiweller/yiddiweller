import Link from "next/link";
import { redirect } from "next/navigation";

import JoinForm from "@/components/studio/JoinForm";
import StudioMark from "@/components/studio/StudioMark";
import { INVITATION_FAILURE } from "@/components/studio/invitationCopy";
import { currentStaff } from "@/lib/auth/guard";
import { inspectInvitation } from "@/lib/db/staff";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Accept invitation" };

/**
 * The only way to become a member of staff. There is no sign-up: an Owner
 * issues an invitation, and this page is where the single-use token it carries
 * is redeemed.
 *
 * The token is read here only to decide what to show. Redeeming it happens in
 * the server action, which repeats every check, so a stale page cannot admit
 * anyone.
 */
export default async function StudioJoin({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  // Somebody already signed in has nothing to accept.
  if (await currentStaff()) redirect("/studio");

  const { token } = await searchParams;
  const preview = token ? await inspectInvitation(token) : null;

  if (!token || !preview?.ok) {
    const copy = INVITATION_FAILURE[preview && !preview.ok ? preview.reason : "invalid"];
    return (
      <main className={`${styles.tokens} ${styles.entrance}`}>
        <StudioMark className={styles.entranceMark} />
        <h1 className={styles.entranceTitle}>{copy.title}</h1>
        <p className={styles.entranceNote}>{copy.note}</p>
        <Link className={styles.buttonQuiet} href="/studio/login">
          Go to sign in
        </Link>
      </main>
    );
  }

  return (
    <main className={`${styles.tokens} ${styles.entrance}`}>
      <StudioMark className={styles.entranceMark} />
      <h1 className={styles.entranceTitle}>Welcome.</h1>
      <p className={styles.entranceNote}>
        You have been invited to Studio as {preview.role === "owner" ? "an Owner" : "a Member"}.
        One detail and you are in.
      </p>
      <JoinForm token={token} email={preview.email} />
    </main>
  );
}
