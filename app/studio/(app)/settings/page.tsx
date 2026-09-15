import SignOutButton from "@/components/studio/SignOutButton";
import { requireStaff } from "@/lib/auth/guard";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Settings" };

/**
 * Deliberately small. Studio-wide configuration belongs to later phases; this
 * is the account you are signed in as and the way out.
 */
export default async function StudioSettings() {
  const staff = await requireStaff();

  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Settings</h1>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Account</h2>
        </div>
        <ul className={styles.rows}>
          <li className={styles.row}>
            <span className={styles.rowPrimary}>Name</span>
            <span className={styles.rowSecondary}>{staff.name}</span>
          </li>
          <li className={styles.row}>
            <span className={styles.rowPrimary}>Email</span>
            <span className={styles.rowSecondary}>{staff.email}</span>
          </li>
          <li className={styles.row}>
            <span className={styles.rowPrimary}>Role</span>
            <span className={styles.rowSecondary}>{staff.role}</span>
          </li>
        </ul>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Session</h2>
        </div>
        <p className={styles.empty}>
          Signing out ends this session everywhere it is open on this device.
        </p>
        <div className={styles.actions}>
          <SignOutButton />
        </div>
      </section>
    </>
  );
}
