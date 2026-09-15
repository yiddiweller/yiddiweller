import { LIMITS, label } from "@/lib/business";
import { PROJECT_STATUSES } from "@/lib/db/schema";
import styles from "@/app/studio/studio.module.css";

/** The fields of a project, shared by every form that writes one. */
export default function ProjectFields({
  id,
  people,
  clients,
  defaults,
}: {
  id: string;
  /** Studio members, for operational ownership. Never an access control. */
  people: { id: string; name: string }[];
  /** Offered only where the client is not already decided. */
  clients?: { id: string; name: string }[];
  defaults?: {
    name: string;
    status: string;
    description: string;
    notes: string;
    ownerId: string | null;
    startsOn: string | null;
    targetOn: string | null;
  };
}) {
  return (
    <>
      {clients ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-clientId`}>
            Client
          </label>
          <select id={`${id}-clientId`} name="clientId" required className={styles.select}>
            <option value="">Choose a client</option>
            {clients.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          <p className={styles.hint}>Work is always for somebody, and this cannot be changed later.</p>
        </div>
      ) : null}

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
        <label className={styles.label} htmlFor={`${id}-status`}>
          Status
        </label>
        <select
          id={`${id}-status`}
          name="status"
          defaultValue={defaults?.status ?? "planned"}
          className={styles.select}
        >
          {PROJECT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-ownerId`}>
          Looked after by
        </label>
        <select
          id={`${id}-ownerId`}
          name="ownerId"
          defaultValue={defaults?.ownerId ?? ""}
          className={styles.select}
        >
          <option value="">Nobody yet</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-startsOn`}>
          Starts
        </label>
        <input
          id={`${id}-startsOn`}
          name="startsOn"
          type="date"
          defaultValue={defaults?.startsOn ?? ""}
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-targetOn`}>
          Target
        </label>
        <input
          id={`${id}-targetOn`}
          name="targetOn"
          type="date"
          defaultValue={defaults?.targetOn ?? ""}
          className={styles.input}
        />
        <p className={styles.hint}>A day, not a time. Nobody&rsquo;s timezone can move it.</p>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-description`}>
          What the work is
        </label>
        <textarea
          id={`${id}-description`}
          name="description"
          maxLength={LIMITS.description}
          defaultValue={defaults?.description}
          className={`${styles.input} ${styles.textarea}`}
        />
      </div>

      {defaults ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${id}-notes`}>
            Notes
          </label>
          <textarea
            id={`${id}-notes`}
            name="notes"
            maxLength={LIMITS.notes}
            defaultValue={defaults.notes}
            className={`${styles.input} ${styles.textarea}`}
          />
        </div>
      ) : null}
    </>
  );
}
