import SignOutButton from "@/components/studio/SignOutButton";
import styles from "@/app/studio/studio.module.css";

/**
 * Who you are signed in as, and the way out. Sits at the foot of the rail:
 * identity is context, not a task, so it stays reachable without competing
 * with the navigation above it.
 */
export default function StudioAccount({ name, role }: { name: string; role: string }) {
  return (
    <div className={styles.account}>
      <span className={styles.accountName}>{name}</span>
      <span className={styles.accountRole}>{role}</span>
      <SignOutButton quiet />
    </div>
  );
}
