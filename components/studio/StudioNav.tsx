"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { isCurrent, STUDIO_NAV } from "@/lib/studio-nav";
import styles from "@/app/studio/studio.module.css";

/**
 * The navigation itself, shared by the rail and the drawer so the two can
 * never drift apart. `onNavigate` is how the drawer closes behind a choice.
 */
export default function StudioNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const showGroupLabels = STUDIO_NAV.length > 1;

  return (
    <nav className={styles.nav} aria-label="Studio">
      {STUDIO_NAV.map((group) => (
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
