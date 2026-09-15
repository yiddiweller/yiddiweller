import Link from "next/link";
import { notFound } from "next/navigation";

import AuditTrail from "@/components/studio/AuditTrail";
import ContactFields from "@/components/studio/ContactFields";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import RelationshipFields from "@/components/studio/RelationshipFields";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { isId, label } from "@/lib/business";
import { listEntityAudit } from "@/lib/db/audit";
import { selectableClients } from "@/lib/db/clients";
import { contactRelationships, findContact } from "@/lib/db/contacts";
import { leadsFor } from "@/lib/db/leads";
import styles from "@/app/studio/studio.module.css";

import {
  archiveContactAction,
  attachContactAction,
  detachContactAction,
  restoreContactAction,
  updateClientContactAction,
  updateContactAction,
} from "../actions";

/**
 * The tab says which record this is — but only to somebody entitled to know.
 *
 * `generateMetadata` runs independently of the page component, so a page whose
 * guard refuses the request still has its title rendered, and a redirect or a
 * 404 body carries it. Measured: an inactive member's 307 to the sign-in page
 * contained `Northwind Trading — Studio`, which tells somebody with no access
 * at all the name of a client. So this checks too, with `currentStaff` rather
 * than a guard, because refusing from metadata is not its job — falling back to
 * the generic title is.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isId(id) || !(await currentStaff())) return { title: "Contact" };
  const record = await findContact(id);
  return { title: record?.name ?? "Contact" };
}

/** One person: who they are, who they are to us, and what they brought in. */
export default async function StudioContact({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const contact = await findContact(id);
  if (!contact) notFound();

  const isOwner = viewer.role === "owner";
  const [relationships, clients, leads, history] = await Promise.all([
    contactRelationships(id),
    selectableClients(),
    leadsFor({ contactId: id }),
    isOwner ? listEntityAudit("contact", id) : Promise.resolve([]),
  ]);

  return (
    <>
      <Link className={styles.back} href="/studio/contacts">
        ← Contacts
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {contact.title ?? "Contact"}
            {contact.archivedAt ? " · Archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>{contact.name}</h1>
          {contact.email ? (
            <p className={styles.pageNote}>
              <a className={styles.rowLink} href={`mailto:${contact.email}`}>
                {contact.email}
              </a>
            </p>
          ) : null}
        </div>

        <div className={styles.pageActions}>
          <FormDialog
            trigger="Edit"
            title="Edit contact"
            submitLabel="Save"
            busyLabel="Saving"
            variant="secondary"
            action={updateContactAction}
          >
            <input type="hidden" name="id" value={contact.id} />
            <input type="hidden" name="version" value={contact.version} />
            <ContactFields id="edit-contact" defaults={contact} />
          </FormDialog>

          {isOwner ? (
            contact.archivedAt ? (
              <RecordAction
                action={restoreContactAction}
                fields={{ id: contact.id, version: contact.version }}
                label="Restore"
                busyLabel="Restoring"
              />
            ) : (
              <RecordAction
                action={archiveContactAction}
                fields={{ id: contact.id, version: contact.version }}
                label="Archive"
                busyLabel="Archiving"
                confirm={`Archive ${contact.name}? Nothing is deleted, and their history stays.`}
              />
            )
          ) : null}
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section} aria-label="Overview">
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Phone</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {contact.phone ?? "—"}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Clients</span>
              <span className={styles.factValue}>{relationships.length}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Known since</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                <Moment iso={contact.createdAt.toISOString()} style="day" />
              </span>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Clients</h2>
            <span className={styles.pageActions}>
              <FormDialog
                trigger="Relate to a client"
                title={`Relate ${contact.name} to a client`}
                submitLabel="Add"
                busyLabel="Adding"
                variant="quiet"
                action={attachContactAction}
              >
                <input type="hidden" name="contactId" value={contact.id} />
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="relate-clientId">
                    Client
                  </label>
                  <select id="relate-clientId" name="clientId" required className={styles.select}>
                    <option value="">Choose a client</option>
                    {clients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </select>
                </div>
                <RelationshipFields id="relate-contact" hidePerson />
              </FormDialog>
            </span>
          </div>

          {relationships.length === 0 ? (
            <p className={styles.empty}>
              Not related to any client yet. Somebody can be a contact long before they are one.
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {relationships.map((row) => (
                <li key={row.id} className={`${styles.row} ${row.clientArchived ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/clients/${row.clientId}`}>
                      {row.clientName}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>{row.role ?? "—"}</span>
                  <span className={styles.rowMeta}>
                    {row.isPrimary ? <span className={`${styles.tag} ${styles.tagStrong}`}>Primary</span> : null}
                  </span>
                  <span className={styles.rowActions}>
                    <FormDialog
                      trigger="Edit"
                      title={`${contact.name} at ${row.clientName}`}
                      submitLabel="Save"
                      busyLabel="Saving"
                      variant="quiet"
                      action={updateClientContactAction}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="version" value={row.version} />
                      <RelationshipFields id={`contact-rel-${row.id}`} hidePerson defaults={row} />
                    </FormDialog>
                    <RecordAction
                      action={detachContactAction}
                      fields={{ id: row.id }}
                      label="Remove"
                      busyLabel="Removing"
                      confirm={`Remove ${contact.name} from ${row.clientName}?`}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {leads.length > 0 ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Opportunities</h2>
            </div>
            <ul className={`${styles.list} ${styles.listThreeUp}`}>
              {leads.map((lead) => (
                <li key={lead.id} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/leads/${lead.id}`}>
                      {lead.title}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>{lead.clientName ?? lead.prospectName ?? "—"}</span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{label(lead.stage)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {contact.notes ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Notes</h2>
            </div>
            <p className={styles.prose}>{contact.notes}</p>
          </section>
        ) : null}

        {isOwner ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>History</h2>
              <span className={styles.sectionNote}>What changed, never what it said</span>
            </div>
            <AuditTrail events={history} />
          </section>
        ) : null}
      </div>
    </>
  );
}
