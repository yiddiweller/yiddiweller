import Moment from "@/components/studio/Moment";
import { type AuditRow } from "@/lib/db/audit";
import styles from "@/app/studio/studio.module.css";

/**
 * What happened to a record, in the order it happened.
 *
 * Only ever the names of what changed, never the values: the log says that the
 * notes were edited, not what they now say. The reasoning, and the full list of
 * what may never be written into an event, is in docs/audit.md.
 */

const ACTIONS: Record<string, string> = {
  "client.created": "Client created",
  "client.updated": "Client edited",
  "client.archived": "Client archived",
  "client.restored": "Client restored",
  "contact.created": "Contact created",
  "contact.updated": "Contact edited",
  "contact.archived": "Contact archived",
  "contact.restored": "Contact restored",
  "client_contact.attached": "Added to a client",
  "client_contact.updated": "Relationship edited",
  "client_contact.detached": "Removed from a client",
  "lead.created": "Lead created",
  "lead.created_from_inquiry": "Lead created from an inquiry",
  "lead.updated": "Lead edited",
  "lead.moved": "Lead moved",
  "lead.converted": "Lead converted",
  "lead.archived": "Lead archived",
  "lead.restored": "Lead restored",
  "project.created": "Project created",
  "project.updated": "Project edited",
  "project.archived": "Project archived",
  "project.restored": "Project restored",
  "project_contact.attached": "Added to a project",
  "project_contact.updated": "Relationship edited",
  "project_contact.detached": "Removed from a project",
  "workroom.created": "Workroom created",
  "workroom.updated": "Workroom edited",
  "workroom.published": "Workroom published",
  "workroom.unpublished": "Workroom unpublished",
  "workroom.archived": "Workroom archived",
  "workroom.restored": "Workroom restored",
  "workroom_invitation.created": "Invitation sent",
  "workroom_invitation.resent": "Invitation resent",
  "workroom_invitation.revoked": "Invitation revoked",
  "workroom_invitation.accepted": "Invitation accepted",
  "workroom_member.granted": "Access given",
  "workroom_member.revoked": "Access taken away",
  "client_identity.created": "Client sign-in created",
  "client_identity.disabled": "Client sign-in switched off",
  "client_identity.enabled": "Client sign-in switched on",
};

export function describeAction(action: string): string {
  return ACTIONS[action] ?? action;
}

/** The one-line detail under an event, built only from what is safe to show. */
function detail(event: AuditRow): string | null {
  const fields = event.metadata.fields;
  if (Array.isArray(fields) && fields.length > 0) {
    return `Changed ${fields.join(", ")}`;
  }
  if (event.action === "lead.moved") {
    const { from, to } = event.metadata as { from?: string; to?: string };
    return from && to ? `${from} → ${to}` : null;
  }
  return null;
}

export default function AuditTrail({
  events,
  showEntity = false,
}: {
  events: AuditRow[];
  showEntity?: boolean;
}) {
  if (events.length === 0) {
    return <p className={styles.empty}>Nothing has happened to this yet.</p>;
  }

  return (
    <ul className={`${styles.list} ${styles.listFourUp}`}>
      {events.map((event) => (
        <li key={event.id} className={styles.row}>
          <span className={styles.rowPrimary}>{describeAction(event.action)}</span>
          <span className={styles.rowSecondary}>
            {showEntity ? (event.entityLabel ?? "—") : (detail(event) ?? "")}
          </span>
          <span className={styles.rowMeta}>
            {event.actorName ?? "Someone since removed"}
            {/* Who it was is half the record; which side of the company they
                were on is the other half, and the two identity systems are
                deliberately different tables. */}
            {event.actorKind === "client_user" ? <span className={styles.tag}> Client</span> : null}
          </span>
          <Moment className={styles.rowMeta} iso={event.occurredAt.toISOString()} />
        </li>
      ))}
    </ul>
  );
}
