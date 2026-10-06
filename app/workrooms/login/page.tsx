import { redirect } from "next/navigation";

import WorkroomMark from "@/components/workrooms/WorkroomMark";
import SignInForm from "@/components/workrooms/SignInForm";
import { currentViewer } from "@/lib/client-auth/guard";
import { WORKROOM_HOME, workroomReturn } from "@/lib/client-auth/redirect";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * The way back in.
 *
 * Passwordless, and there is no way to create an account here: the only route
 * to one is an invitation from the studio. The form never says whether an
 * address is known — a link is sent only to somebody who actually has access,
 * and every other case produces this same page with nothing sent.
 *
 * No marketing, no "join", no product name. A client is not signing up for
 * software.
 *
 * `next` is the page somebody was sent here from. It is judged by the one
 * client redirect rule and, if it fails, quietly becomes the Workroom list —
 * nothing on this page changes for it, and it opens nothing by itself: the
 * page it names checks access when it is reached.
 */
export default async function WorkroomLogin({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const destination = workroomReturn(next);
  if (await currentViewer()) redirect(destination);

  return (
    <main className={`${styles.tokens} ${styles.entrance}`}>
      <WorkroomMark className={styles.entranceMark} />
      <h1 className={styles.entranceTitle}>Your workroom.</h1>
      <p className={styles.entranceNote}>
        Enter the address we use for you and we will send a link that opens it. No password.
      </p>
      <SignInForm next={destination === WORKROOM_HOME ? undefined : destination} />
    </main>
  );
}
