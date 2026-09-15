"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isCurrent, navFor, type StudioNavGroup } from "@/lib/studio-nav";
import { type StaffRole } from "@/lib/db/schema";
import styles from "@/app/studio/studio.module.css";

/**
 * The navigation itself, shared by the rail and the drawer so the two can
 * never drift apart. `onNavigate` is how the drawer closes behind a choice.
 *
 * The role decides which items are worth showing, not which are reachable:
 * every page re-checks the caller on the server. Hiding a link is tidiness.
 */
export default function StudioNav({
  role,
  onNavigate,
}: {
  role: StaffRole;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const groups: StudioNavGroup[] = navFor(role);
  const showGroupLabels = groups.length > 1;

  return (
    <nav className={styles.nav} aria-label="Studio">
      {groups.map((group) => (
        <div key={group.label}>
          {showGroupLabels ? <p className={styles.navGroupLabel}>{group.label}</p> : null}
          <ul className={styles.navGroup}>
            {group.items.map((item) => {
              const current = isCurrent(item.href, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`${styles.navLink} ${current ? styles.navLinkActive : ""}`}
                    aria-current={current ? "page" : undefined}
                    onClick={onNavigate}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
