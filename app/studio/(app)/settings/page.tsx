import SignOutButton from "@/components/studio/SignOutButton";
import { requireStaff } from "@/lib/auth/guard";
import Moment from "@/components/studio/Moment";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Settings" };

/**
 * Deliberately small, and finished rather than stubbed.
 *
 * Studio-wide configuration belongs to the phases that introduce something to
 * configure. What exists today is the account you are signed in as, what that
 * account can do, and the way out — so that is what this page contains. No
 * empty "Company" or "Notifications" sections waiting to be filled: a dead
 * section is worse than an absent one.
 */
export default async function StudioSettings() {
  const staff = await requireStaff();
  const isOwner = staff.role === "owner";

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>Your account</p>
          <h1 className={styles.pageTitle}>Settings</h1>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Account</h2>
          </div>
          <ul className={`${styles.list} ${styles.listPair}`}>
            <li className={styles.row}>
              <span className={styles.rowMeta}>Name</span>
              <span className={styles.rowPrimary}>{staff.name}</span>
            </li>
            <li className={styles.row}>
              <span className={styles.rowMeta}>Email</span>
              <span className={styles.rowPrimary}>{staff.email}</span>
            </li>
            <li className={styles.row}>
              <span className={styles.rowMeta}>Joined</span>
              <span className={styles.rowPrimary}>
                <Moment iso={staff.createdAt.toISOString()} style="day" />
              </span>
            </li>
          </ul>
          <p className={styles.hint}>
            Your name and address come from the invitation you accepted. Ask an Owner to change
            them.
          </p>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Access</h2>
          </div>
          <ul className={`${styles.list} ${styles.listPair}`}>
            <li className={styles.row}>
              <span className={styles.rowMeta}>Role</span>
              <span className={styles.rowPrimary}>
                <span className={`${styles.tag} ${isOwner ? styles.tagStrong : ""}`}>{staff.role}</span>
              </span>
            </li>
          </ul>
          <p className={styles.hint}>
            {isOwner
              ? "You can invite people, and remove or restore access on the Team page."
              : "You can sign in and see the team. Inviting and removing access is an Owner's to do."}
          </p>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Sign in and sessions</h2>
          </div>
          <p className={styles.hint}>
            Studio has no password. You sign in with a link sent to {staff.email}, which works
            once and expires after ten minutes. A session lasts seven days, and signing out ends
            this one straight away.
          </p>
          <div className={styles.actions}>
            <SignOutButton />
          </div>
        </section>
      </div>
    </>
  );
}
