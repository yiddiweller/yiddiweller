import styles from "@/app/studio/studio.module.css";

/** The wordmark as type, two lines. Same restraint as the public header. */
export default function StudioMark({ className }: { className?: string }) {
  return (
    <span className={`${styles.brand} ${className ?? ""}`}>
      <span className={styles.brandName}>Yiddi Weller</span>
      <span className={styles.brandProduct}>Studio</span>
    </span>
  );
}
