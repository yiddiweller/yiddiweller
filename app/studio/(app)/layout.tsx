import SignOutButton from "@/components/studio/SignOutButton";
import StudioMark from "@/components/studio/StudioMark";
import StudioNav from "@/components/studio/StudioNav";
import { requireStaff } from "@/lib/auth/guard";
import styles from "@/app/studio/studio.module.css";

/**
 * The signed-in shell. `requireStaff` runs before any child renders, so no
 * private data is ever produced for an unauthorised request — it is not hidden
 * after the fact, it is never fetched.
 */
export default async function StudioAppLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireStaff();

  return (
    <div className={styles.shell}>
      <a href="#studio-main" className="skip">
        Skip to content
      </a>
      <header className={styles.rail}>
        <StudioMark />
        <StudioNav />
        <div className={styles.account}>
          <span>{staff.name}</span>
          <SignOutButton quiet />
        </div>
      </header>
      <main id="studio-main" className={styles.main}>{children}</main>
    </div>
  );
}
