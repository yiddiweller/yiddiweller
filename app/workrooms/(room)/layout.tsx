import WorkroomMark from "@/components/workrooms/WorkroomMark";
import SignOut from "@/components/workrooms/SignOut";
import { requireViewer } from "@/lib/client-auth/guard";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * The signed-in client shell. One header line and a column of content.
 *
 * `requireViewer` here produces the redirect for an anonymous request, and is
 * defence in depth — it is **not** what protects a page's data. Every page
 * below calls it again before its own read, because a guard in a parent layout
 * does not stop its page running. The measurements are in lib/auth/guard.ts.
 */
export default async function WorkroomShell({ children }: { children: React.ReactNode }) {
  const viewer = await requireViewer();

  return (
    <div className={`${styles.tokens} ${styles.shell}`}>
      <a href="#workroom-main" className="skip">
        Skip to content
      </a>

      <header className={styles.header}>
        <WorkroomMark />
        <div className={styles.headerRight}>
          <span className={styles.who}>{viewer.name}</span>
          <SignOut />
        </div>
      </header>

      <main id="workroom-main" className={styles.main}>
        {children}
      </main>

      <footer className={styles.footer}>Private · Yiddi Weller</footer>
    </div>
  );
}
