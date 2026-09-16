import styles from "@/app/workrooms/workroom.module.css";

/** Set as type, like everywhere else, so it renders before anything loads. */
export default function WorkroomMark({ className }: { className?: string }) {
  return (
    <span className={`${styles.mark} ${className ?? ""}`}>
      <span>Yiddi Weller</span>
      <span className={styles.markSub}>Workroom</span>
    </span>
  );
}
