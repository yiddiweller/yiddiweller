import { LIMITS } from "@/lib/business";
import styles from "@/app/studio/studio.module.css";

/** The fields of a contact, shared by the form that creates one and the one that edits it. */
export default function ContactFields({
  id,
  defaults,
}: {
  id: string;
  defaults?: {
    name: string;
    email: string | null;
    phone: string | null;
    title: string | null;
    notes: string;
  };
}) {
  return (
    <>
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-name`}>
          Name
        </label>
        <input
          id={`${id}-name`}
          name="name"
          required
          maxLength={LIMITS.name}
          defaultValue={defaults?.name}
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-email`}>
          Email
        </label>
        <input
          id={`${id}-email`}
          name="email"
          type="email"
          inputMode="email"
          maxLength={LIMITS.email}
          defaultValue={defaults?.email ?? ""}
          autoComplete="off"
          className={styles.input}
        />
        <p className={styles.hint}>
          Shared addresses are fine. Two people can have the same one.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-phone`}>
          Phone
        </label>
        <input
          id={`${id}-phone`}
          name="phone"
          type="tel"
          inputMode="tel"
          maxLength={LIMITS.phone}
          defaultValue={defaults?.phone ?? ""}
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-title`}>
          Title
        </label>
        <input
          id={`${id}-title`}
          name="title"
          maxLength={LIMITS.title}
          defaultValue={defaults?.title ?? ""}
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-notes`}>
          Notes
        </label>
        <textarea
          id={`${id}-notes`}
          name="notes"
          maxLength={LIMITS.notes}
          defaultValue={defaults?.notes}
          className={`${styles.input} ${styles.textarea}`}
        />
      </div>
    </>
  );
}
