import Link from "next/link";
import { notFound } from "next/navigation";

import AuditTrail from "@/components/studio/AuditTrail";
import ClientFields from "@/components/studio/ClientFields";
import ContactFields from "@/components/studio/ContactFields";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import ProjectFields from "@/components/studio/ProjectFields";
import RecordAction from "@/components/studio/RecordAction";
import RelationshipFields from "@/components/studio/RelationshipFields";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { isId, label } from "@/lib/business";
import { listEntityAudit } from "@/lib/db/audit";
import { findClient } from "@/lib/db/clients";
import { clientContactRows, selectableContacts } from "@/lib/db/contacts";
import { leadsFor } from "@/lib/db/leads";
import { listProjects } from "@/lib/db/projects";
import { listStaff } from "@/lib/db/staff";
import styles from "@/app/studio/studio.module.css";

import { archiveClientAction, restoreClientAction, updateClientAction } from "../actions";
import {
  attachContactAction,
  createContactAction,
  detachContactAction,
  updateClientContactAction,
} from "../../contacts/actions";
import { createProjectAction } from "../../projects/actions";

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
  if (!isId(id) || !(await currentStaff())) return { title: "Client" };
  const record = await findClient(id);
  return { title: record?.name ?? "Client" };
}

/**
 * One client: the relationship, the people in it, the work, and how it got
 * here.
 *
 * `requireStaff` runs inside this component, before the first read, because a
 * guard in a parent layout does not gate a page — Next renders them
 * concurrently and the page would fetch and ship its data anyway. The reasoning
 * and the measurements are in lib/auth/guard.ts.
 */
export default async function StudioClient({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const client = await findClient(id);
  if (!client) notFound();

  const isOwner = viewer.role === "owner";
  const [contacts, people, projects, leads, staff, history] = await Promise.all([
    clientContactRows(id),
    selectableContacts(),
    listProjects({ clientId: id, pageSize: 50 }),
    leadsFor({ clientId: id }),
    listStaff(),
    // Owner-only, so it is not fetched at all for anybody else rather than
    // fetched and then hidden in markup that ships either way.
    isOwner ? listEntityAudit("client", id) : Promise.resolve([]),
  ]);

  const active = staff.filter((person) => person.status === "active");

  return (
    <>
      <Link className={styles.back} href="/studio/clients">
        ← Clients
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {label(client.accountType)}
            {client.archivedAt ? " · Archived" : client.status === "inactive" ? " · Inactive" : ""}
          </p>
          <h1 className={styles.pageTitle}>{client.name}</h1>
          {client.website ? (
            <p className={styles.pageNote}>
              <a className={styles.rowLink} href={client.website} rel="noreferrer noopener" target="_blank">
                {client.domain ?? client.website}
              </a>
            </p>
          ) : null}
        </div>

        <div className={styles.pageActions}>
          <FormDialog
            trigger="Edit"
            title="Edit client"
            submitLabel="Save"
            busyLabel="Saving"
            variant="secondary"
            action={updateClientAction}
          >
            <input type="hidden" name="id" value={client.id} />
            <input type="hidden" name="version" value={client.version} />
            <ClientFields id="edit-client" defaults={client} />
          </FormDialog>

          {isOwner ? (
            client.archivedAt ? (
              <RecordAction
                action={restoreClientAction}
                fields={{ id: client.id, version: client.version }}
                label="Restore"
                busyLabel="Restoring"
              />
            ) : (
              <RecordAction
                action={archiveClientAction}
                fields={{ id: client.id, version: client.version }}
                label="Archive"
                busyLabel="Archiving"
                confirm={{
                  title: `Archive ${client.name}?`,
                  message: "They leave the default lists. Nothing is deleted.",
                  action: "Archive",
                }}
              />
            )
          ) : null}
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section} aria-label="Overview">
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Live work</span>
              <span className={styles.factValue}>
                {projects.rows.filter((project) => project.status === "active" || project.status === "planned" || project.status === "on_hold").length}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>People</span>
              <span className={styles.factValue}>{contacts.length}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Client since</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                <Moment iso={client.createdAt.toISOString()} style="day" />
              </span>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>People</h2>
            <span className={styles.pageActions}>
              <FormDialog
                trigger="Add someone"
                title="Add somebody to this client"
                note="Choose a contact we already know, or add a new one below."
                submitLabel="Add"
                busyLabel="Adding"
                variant="quiet"
                action={attachContactAction}
              >
                <input type="hidden" name="clientId" value={client.id} />
                <RelationshipFields id="attach-contact" people={people} />
              </FormDialog>

              <FormDialog
                trigger="New contact"
                title="New contact for this client"
                submitLabel="Add contact"
                busyLabel="Adding"
                variant="quiet"
                action={createContactAction}
              >
                <input type="hidden" name="clientId" value={client.id} />
                <ContactFields id="new-contact-for-client" />
                <RelationshipFields id="new-contact-rel" hidePerson />
              </FormDialog>
            </span>
          </div>

          {contacts.length === 0 ? (
            <p className={styles.empty}>
              Nobody is listed yet. A client with no named person is a client nobody can ring.
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {contacts.map((row) => (
                <li key={row.id} className={`${styles.row} ${row.contactArchived ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/contacts/${row.contactId}`}>
                      {row.contactName}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    {row.contactEmail ? (
                      <a className={styles.rowLink} href={`mailto:${row.contactEmail}`}>
                        {row.contactEmail}
                      </a>
                    ) : (
                      (row.contactTitle ?? "—")
                    )}
                  </span>
                  <span className={styles.rowMeta}>
                    {row.isPrimary ? <span className={`${styles.tag} ${styles.tagStrong}`}>Primary</span> : null}
                    {row.role ? <span className={styles.tag}> {row.role}</span> : null}
                  </span>
                  <span className={styles.rowActions}>
                    <FormDialog
                      trigger="Edit"
                      title={`${row.contactName} at ${client.name}`}
                      submitLabel="Save"
                      busyLabel="Saving"
                      variant="quiet"
                      action={updateClientContactAction}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="version" value={row.version} />
                      <RelationshipFields id={`rel-${row.id}`} hidePerson defaults={row} />
                    </FormDialog>
                    <RecordAction
                      action={detachContactAction}
                      fields={{ id: row.id }}
                      label="Remove"
                      busyLabel="Removing"
                      confirm={{
                        title: `Remove ${row.contactName} from ${client.name}?`,
                        message: "They stay a contact and keep every other relationship.",
                        action: "Remove",
                        destructive: true,
                      }}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Work</h2>
            {!client.archivedAt ? (
              <span className={styles.pageActions}>
                <FormDialog
                  trigger="New project"
                  title={`New project for ${client.name}`}
                  submitLabel="Add project"
                  busyLabel="Adding"
                  variant="quiet"
                  action={createProjectAction}
                >
                  <input type="hidden" name="clientId" value={client.id} />
                  <ProjectFields id="new-project-for-client" people={active} />
                </FormDialog>
              </span>
            ) : null}
          </div>

          {projects.rows.length === 0 ? (
            <p className={styles.empty}>No work for this client yet.</p>
          ) : (
            <ul className={`${styles.list} ${styles.listThreeUp}`}>
              {projects.rows.map((project) => (
                <li key={project.id} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/projects/${project.id}`}>
                      {project.name}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>{project.ownerName ?? "Nobody yet"}</span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{label(project.status)}</span>
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
                  <span className={styles.rowSecondary}>{lead.contactName ?? "—"}</span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{label(lead.stage)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {client.notes ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Notes</h2>
            </div>
            <p className={styles.prose}>{client.notes}</p>
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
