import Link from "next/link";

import SignatureMark from "@/components/SignatureMark";
import { nav, site } from "@/lib/site";

import styles from "./Header.module.css";

export default function Header() {
  return (
    <header className={`page ${styles.header}`}>
      <Link href="/" className={styles.brand} aria-label={`${site.name} — home`}>
        <SignatureMark className={styles.mark} />
      </Link>

      <nav aria-label="Primary">
        <ul className={styles.nav}>
          {nav.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className={styles.link}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
    </header>
  );
}
