import { CLIENT_ACCOUNT_TYPES, CLIENT_STATUSES } from "@/lib/db/schema";
import { LIMITS, label } from "@/lib/business";
import styles from "@/app/studio/studio.module.css";

/**
 * The fields of a client, in one place, so the form that creates one and the
 * form that edits one cannot drift into asking different questions.
 */
export default function ClientFields({
  id,
  defaults,
}: {
  id: string;
  defaults?: {
    accountType: string;
    name: string;
    website: string | null;
    status: string;
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
        <label className={styles.label} htmlFor={`${id}-accountType`}>
          Kind
        </label>
        <select
          id={`${id}-accountType`}
          name="accountType"
          defaultValue={defaults?.accountType ?? "organization"}
          className={styles.select}
        >
          {CLIENT_ACCOUNT_TYPES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-website`}>
          Website
        </label>
        <input
          id={`${id}-website`}
          name="website"
          type="url"
          inputMode="url"
          maxLength={LIMITS.website}
          defaultValue={defaults?.website ?? ""}
          placeholder="https://"
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-status`}>
          Status
        </label>
        <select
          id={`${id}-status`}
          name="status"
          defaultValue={defaults?.status ?? "active"}
          className={styles.select}
        >
          {CLIENT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
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
        <p className={styles.hint}>
          Internal. Nobody outside the studio ever sees this.
        </p>
      </div>
    </>
  );
}
