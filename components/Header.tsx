import Link from "next/link";

import SignatureMark from "@/components/SignatureMark";
import { site } from "@/lib/site";

import styles from "./Header.module.css";

/** The mark alone. Contact sits under the name on the homepage instead. */
export default function Header() {
  return (
    <header className={`page ${styles.header}`}>
      <Link href="/" className={styles.brand} aria-label={`${site.name} — home`}>
        <SignatureMark className={styles.mark} />
      </Link>
    </header>
  );
}
