"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "@/app/studio/studio.module.css";

/**
 * Only areas that actually work appear here. Empty sections for features that
 * do not exist yet would be dead navigation, and Studio has none.
 */
const ITEMS = [
  { href: "/studio", label: "Home" },
  { href: "/studio/team", label: "Team" },
  { href: "/studio/settings", label: "Settings" },
] as const;

export default function StudioNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Studio">
      <ul className={styles.nav}>
        {ITEMS.map((item) => {
          const active =
            item.href === "/studio" ? pathname === "/studio" : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={`${styles.navLink} ${active ? styles.navLinkActive : ""}`}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
