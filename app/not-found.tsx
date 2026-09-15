import Link from "next/link";

import PublicFrame from "@/components/PublicFrame";

import styles from "./not-found.module.css";

/**
 * The 404 for an unmatched URL. It lives at the root rather than inside the
 * `(public)` group because Next renders this file inside the root layout, so
 * the group's chrome would not reach it; it brings the frame itself instead.
 *
 * Studio has its own, in `app/studio/(app)/not-found.tsx`, which is what a
 * member sees when they reach an Owner-only page.
 */
export default function NotFound() {
  return (
    <PublicFrame>
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
    </PublicFrame>
  );
}
