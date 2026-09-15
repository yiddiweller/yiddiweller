import MomentInput from "@/components/studio/MomentInput";
import { LIMITS, label } from "@/lib/business";
import { LEAD_SOURCES } from "@/lib/db/schema";
import styles from "@/app/studio/studio.module.css";

/**
 * The fields of a lead.
 *
 * A lead can name a prospect that is not a client yet — that is the whole point
 * of it — so the client is optional here and the plain name of a company sits
 * beside it. Stage is deliberately absent: moving through the pipeline has
 * consequences, and it has its own control.
 */
export default function LeadFields({
  id,
  people,
  clients,
  contacts,
  defaults,
}: {
  id: string;
  people: { id: string; name: string }[];
  clients: { id: string; name: string }[];
  contacts: { id: string; name: string; email: string | null }[];
  defaults?: {
    title: string;
    source: string;
    contactId: string | null;
    clientId: string | null;
    prospectName: string | null;
    summary: string;
    nextStep: string;
    followUpAt: Date | null;
    ownerId: string | null;
  };
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
          placeholder="What the opportunity is"
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-source`}>
          Came from
        </label>
        <select
          id={`${id}-source`}
          name="source"
          defaultValue={defaults?.source ?? "manual"}
          className={styles.select}
        >
          {LEAD_SOURCES.map((value) => (
            <option key={value} value={value}>
              {label(value)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-clientId`}>
          Client
        </label>
        <select
          id={`${id}-clientId`}
          name="clientId"
          defaultValue={defaults?.clientId ?? ""}
          className={styles.select}
        >
          <option value="">Not a client yet</option>
          {clients.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-prospectName`}>
          Prospect
        </label>
        <input
          id={`${id}-prospectName`}
          name="prospectName"
          maxLength={LIMITS.name}
          defaultValue={defaults?.prospectName ?? ""}
          placeholder="The company, before it is a client"
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-contactId`}>
          Person
        </label>
        <select
          id={`${id}-contactId`}
          name="contactId"
          defaultValue={defaults?.contactId ?? ""}
          className={styles.select}
        >
          <option value="">Nobody yet</option>
          {contacts.map((contact) => (
            <option key={contact.id} value={contact.id}>
              {contact.email ? `${contact.name} — ${contact.email}` : contact.name}
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
        <label className={styles.label} htmlFor={`${id}-nextStep`}>
          Next step
        </label>
        <input
          id={`${id}-nextStep`}
          name="nextStep"
          maxLength={LIMITS.nextStep}
          defaultValue={defaults?.nextStep}
          placeholder="Send the proposal"
          autoComplete="off"
          className={styles.input}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${id}-followUpAt`}>
          Follow up
        </label>
        <MomentInput
          id={`${id}-followUpAt`}
          name="followUpAt"
          iso={defaults?.followUpAt ? defaults.followUpAt.toISOString() : null}
        />
        <p className={styles.hint}>Your own time, stored as an instant.</p>
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
      </div>
    </>
  );
}
