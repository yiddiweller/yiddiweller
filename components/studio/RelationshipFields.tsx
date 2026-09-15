import { LIMITS } from "@/lib/business";
import styles from "@/app/studio/studio.module.css";

/**
 * What somebody is to a client or to a project: which person, what they do, and
 * whether they are the one we speak to. Shared by both, because the answer to
 * "who is this to us" has the same shape either way.
 */
export default function RelationshipFields({
  id,
  people,
  defaults,
  hidePerson = false,
}: {
  id: string;
  people?: { id: string; name: string; email: string | null }[];
  defaults?: { role: string | null; isPrimary: boolean };
  hidePerson?: boolean;
}) {
  return (
    <>
      {!hidePerson && people ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-contactId`}>
            Person
          </label>
          <select id={`${id}-contactId`} name="contactId" required className={styles.select}>
            <option value="">Choose somebody</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.email ? `${person.name} — ${person.email}` : person.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-role`}>
          Role
        </label>
        <input
          id={`${id}-role`}
          name="role"
          maxLength={LIMITS.role}
          defaultValue={defaults?.role ?? ""}
          placeholder="Day to day, billing, approvals"
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={`${styles.field} ${styles.check}`}>
        <input
          id={`${id}-isPrimary`}
          name="isPrimary"
          type="checkbox"
          defaultChecked={defaults?.isPrimary}
        />
        <label className={styles.label} htmlFor={`${id}-isPrimary`}>
          The person we speak to
        </label>
      </div>
    </>
  );
}
