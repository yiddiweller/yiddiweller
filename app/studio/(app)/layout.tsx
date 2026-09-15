import StudioAccount from "@/components/studio/StudioAccount";
import StudioDrawer from "@/components/studio/StudioDrawer";
import StudioMark from "@/components/studio/StudioMark";
import StudioNav from "@/components/studio/StudioNav";
import { requireStaff } from "@/lib/auth/guard";
import styles from "@/app/studio/studio.module.css";

/**
 * The signed-in shell, and the only place Studio's chrome is defined.
 *
 * `requireStaff` runs before any child renders, so no private data is ever
 * produced for an unauthorised request — it is not hidden after the fact, it
 * is never fetched.
 *
 * One shell, two presentations: a fixed left rail on desktop, a top bar and a
 * drawer below 1040px. Both are driven by the same navigation data, so the two
 * cannot drift apart. The design reasoning is in docs/studio-design.md.
 */
export default async function StudioAppLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff();
  const account = <StudioAccount name={staff.name} role={staff.role} />;

  return (
    <div className={`${styles.tokens} ${styles.shell}`}>
      <a href="#studio-main" className="skip">
        Skip to content
      </a>

      {/* Not a <nav> itself: StudioNav inside it is the landmark, and two
          nested navigation landmarks with the same name help nobody. */}
      <div className={styles.rail}>
        <StudioMark />
        <div className={styles.railBody}>
          <StudioNav role={staff.role} />
        </div>
        {account}
      </div>

      <div className={styles.shellBody}>
        <header className={styles.topbar}>
          <StudioMark />
          <StudioDrawer role={staff.role}>{account}</StudioDrawer>
        </header>

        <main id="studio-main" className={styles.main}>
          {children}
        </main>
      </div>
    </div>
  );
}
