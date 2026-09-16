import { LIMITS } from "@/lib/business";
import styles from "@/app/studio/studio.module.css";

/**
 * What a client reads. Both fields are the Workroom's own, never a copy of
 * anything internal — `projects.description` and every `notes` field stay where
 * they were written. See docs/workrooms.md.
 */
export default function WorkroomFields({
  id,
  defaults,
}: {
  id: string;
  defaults?: { title: string; summary: string };
}) {
  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-title`}>
          Title
        </label>
        <input
          id={`${id}-title`}
          name="title"
          required
          maxLength={LIMITS.name}
          defaultValue={defaults?.title}
          autoComplete="off"
          className={styles.input}
        />
        <p className={styles.hint}>What the client sees at the top of their page.</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-summary`}>
          Summary
        </label>
        <textarea
          id={`${id}-summary`}
          name="summary"
          maxLength={LIMITS.summary}
          defaultValue={defaults?.summary}
          className={`${styles.input} ${styles.textarea}`}
        />
        <p className={styles.hint}>
          The paragraph they read first. Written for them, not for us.
        </p>
      </div>
    </>
  );
}
