import Link from "next/link";

import styles from "./not-found.module.css";

export default function NotFound() {
  return (
    <section className={`page ${styles.section}`}>
      <h1 className={styles.code}>404</h1>
      <p className={styles.text}>Page not found.</p>
      <Link href="/" className={styles.home}>
        Home
        <span aria-hidden="true" className={styles.arrow}>
          →
        </span>
      </Link>
    </section>
  );
}
