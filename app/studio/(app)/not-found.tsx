import Link from "next/link";

import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Not found" };

/**
 * Studio's own 404, inside the signed-in shell.
 *
 * It is what a Member sees at an Owner-only page, because `requireOwner`
 * answers not-found rather than forbidden: Studio does not confirm to someone
 * without access that a given management surface exists. So this wording says
 * the page was not found, not that permission was refused — the two must read
 * the same to anyone who lands here.
 */
export default function StudioNotFound() {
  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <h1 className={styles.pageTitle}>Not found.</h1>
          <p className={styles.pageNote}>That page does not exist, or is not yours to open.</p>
        </div>
      </div>
      <Link className={styles.buttonQuiet} href="/studio">
        Back to Home
      </Link>
    </>
  );
}
