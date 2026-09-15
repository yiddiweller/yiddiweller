import styles from "@/app/studio/studio.module.css";

/**
 * Shown while a Studio page fetches. Every page here is dynamic — each one is a
 * view of one signed-in person's private data — so this is a real state people
 * will see, not a formality.
 *
 * The shape of what is arriving, at low contrast, rather than a spinner: a
 * spinner says something is happening, a skeleton says what. The shell around
 * it stays put, so navigating does not make the interface flash.
 */
export default function StudioLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="skip">Loading</span>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <span className={styles.skeleton} style={{ width: "80px" }} />
          <span className={styles.skeleton} style={{ width: "220px", height: "28px" }} />
        </div>
      </div>

      <ul className={styles.list}>
        {[0, 1, 2, 3].map((row) => (
          <li key={row} className={styles.skeletonRow}>
            <span className={styles.skeleton} style={{ width: `${58 - row * 8}%` }} />
          </li>
        ))}
      </ul>
    </div>
  );
}
