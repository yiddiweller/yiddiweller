import Link from "next/link";

import AcceptInvitation from "@/components/workrooms/AcceptInvitation";
import WorkroomMark from "@/components/workrooms/WorkroomMark";
import { INVITATION_FAILURE } from "@/components/workrooms/invitationCopy";
import { inspectWorkroomInvitation } from "@/lib/db/workrooms";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * An invitation, opened.
 *
 * **This page consumes nothing.** Mail security scanners and link previewers
 * fetch URLs before a person does, and an invitation spent on a scanner's GET
 * would lock the client out before they ever saw it. So this reads the token to
 * decide what to show, and accepting is a POST from the button below — a
 * deliberate press.
 *
 * The token is read here only to render. `acceptWorkroomInvitation` re-runs
 * every check inside its own transaction, so a stale page cannot admit anybody.
 */
export default async function WorkroomInvite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const checked = await inspectWorkroomInvitation(token);

  if (!checked.ok) {
    const copy = INVITATION_FAILURE[checked.reason];
    return (
      <main className={`${styles.tokens} ${styles.entrance}`}>
        <WorkroomMark className={styles.entranceMark} />
        <h1 className={styles.entranceTitle}>{copy.title}</h1>
        <p className={styles.entranceNote}>{copy.note}</p>
        <p className={styles.actions}>
          <Link className={styles.quiet} href="/workrooms/login">
            Ask for a sign-in link
          </Link>
        </p>
      </main>
    );
  }

  const { preview } = checked;

  return (
    <main className={`${styles.tokens} ${styles.entrance}`}>
      <WorkroomMark className={styles.entranceMark} />
      <p className={styles.eyebrow}>{preview.clientName}</p>
      <h1 className={styles.entranceTitle}>{preview.workroomTitle}</h1>
      <p className={styles.entranceNote}>
        A private space for this work, for you and the people invited to it. Opening it signs you
        in as <strong>{preview.email}</strong>.
      </p>
      <AcceptInvitation token={token} name={preview.contactName} />
    </main>
  );
}
