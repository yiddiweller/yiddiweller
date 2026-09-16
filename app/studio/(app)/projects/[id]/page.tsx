import Link from "next/link";
import { notFound } from "next/navigation";

import AuditTrail from "@/components/studio/AuditTrail";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import ProjectFields from "@/components/studio/ProjectFields";
import RecordAction from "@/components/studio/RecordAction";
import RelationshipFields from "@/components/studio/RelationshipFields";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { isId, label } from "@/lib/business";
import { listEntityAudit } from "@/lib/db/audit";
import { selectableContacts } from "@/lib/db/contacts";
import { leadForProject } from "@/lib/db/leads";
import { findProject, projectContactRows } from "@/lib/db/projects";
import { workroomForProject } from "@/lib/db/workrooms";
import { listStaff } from "@/lib/db/staff";
import WorkroomFields from "@/components/studio/WorkroomFields";
import { createWorkroomAction } from "../../workrooms/actions";
import { formatDate } from "@/lib/studio-format";
import styles from "@/app/studio/studio.module.css";

import {
  archiveProjectAction,
  attachProjectContactAction,
  detachProjectContactAction,
  restoreProjectAction,
  updateProjectAction,
  updateProjectContactAction,
} from "../actions";

const WORKROOM_STATE: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  unpublished: "Unpublished",
};

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
  if (!isId(id) || !(await currentStaff())) return { title: "Project" };
  const record = await findProject(id);
  return { title: record?.name ?? "Project" };
}

/** One project: what the work is, who it is for, who is on it, where it came from. */
export default async function StudioProject({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const project = await findProject(id);
  if (!project) notFound();

  const isOwner = viewer.role === "owner";
  const [people, contacts, lead, staff, workroom, history] = await Promise.all([
    projectContactRows(id),
    selectableContacts(),
    leadForProject(id),
    listStaff(),
    workroomForProject(id),
    isOwner ? listEntityAudit("project", id) : Promise.resolve([]),
  ]);
  const active = staff.filter((person) => person.status === "active");

  return (
    <>
      <Link className={styles.back} href="/studio/projects">
        ← Projects
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {label(project.status)}
            {project.archivedAt ? " · Archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>{project.name}</h1>
          <p className={styles.pageNote}>
            <Link className={styles.rowLink} href={`/studio/clients/${project.clientId}`}>
              {project.clientName}
            </Link>
          </p>
        </div>

        <div className={styles.pageActions}>
          <FormDialog
            trigger="Edit"
            title="Edit project"
            note="The client cannot change: work moved to a different client is different work."
            submitLabel="Save"
            busyLabel="Saving"
            variant="secondary"
            action={updateProjectAction}
          >
            <input type="hidden" name="id" value={project.id} />
            <input type="hidden" name="version" value={project.version} />
            <ProjectFields id="edit-project" people={active} defaults={project} />
          </FormDialog>

          {isOwner ? (
            project.archivedAt ? (
              <RecordAction
                action={restoreProjectAction}
                fields={{ id: project.id, version: project.version }}
                label="Restore"
                busyLabel="Restoring"
              />
            ) : (
              <RecordAction
                action={archiveProjectAction}
                fields={{ id: project.id, version: project.version }}
                label="Archive"
                busyLabel="Archiving"
                confirm={`Archive ${project.name}? Nothing is deleted.`}
              />
            )
          ) : null}
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section} aria-label="Overview">
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Looked after by</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {project.ownerName ?? "Nobody yet"}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Starts</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {formatDate(project.startsOn)}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Target</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {formatDate(project.targetOn)}
              </span>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Client workroom</h2>
            <span className={styles.sectionNote}>The private space for this work</span>
          </div>

          {workroom ? (
            <ul className={`${styles.list} ${styles.listThreeUp}`}>
              <li className={styles.row}>
                <span className={styles.rowPrimary}>
                  <Link className={styles.rowLink} href={`/studio/workrooms/${workroom.id}`}>
                    {workroom.title}
                  </Link>
                </span>
                <span className={styles.rowSecondary}>
                  {workroom.memberCount} {workroom.memberCount === 1 ? "member" : "members"}
                </span>
                <span className={styles.rowMeta}>
                  <span
                    className={`${styles.tag} ${workroom.status === "published" ? styles.tagStrong : ""}`}
                  >
                    {WORKROOM_STATE[workroom.status]}
                  </span>
                  {workroom.archivedAt ? <span className={styles.tag}> Archived</span> : null}
                </span>
              </li>
            </ul>
          ) : project.archivedAt ? (
            <p className={styles.empty}>
              This project is archived, so there is nothing to open a workroom for.
            </p>
          ) : (
            <>
              <p className={styles.empty}>
                No workroom yet. Opening one gives this client a private place for the work —
                nobody sees it until it is published.
              </p>
              <span className={styles.pageActions}>
                <FormDialog
                  trigger="Open a workroom"
                  title={`A workroom for ${project.clientName}`}
                  note="It starts as a draft. You choose when the client can see it."
                  submitLabel="Create workroom"
                  busyLabel="Creating"
                  variant="quiet"
                  action={createWorkroomAction}
                >
                  <input type="hidden" name="projectId" value={project.id} />
                  <WorkroomFields
                    id="new-workroom"
                    defaults={{ title: project.name, summary: "" }}
                  />
                </FormDialog>
              </span>
            </>
          )}
        </section>

        {project.description ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>What the work is</h2>
            </div>
            <p className={styles.prose}>{project.description}</p>
          </section>
        ) : null}

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>People</h2>
            <span className={styles.pageActions}>
              <FormDialog
                trigger="Add someone"
                title={`Add somebody to ${project.name}`}
                submitLabel="Add"
                busyLabel="Adding"
                variant="quiet"
                action={attachProjectContactAction}
              >
                <input type="hidden" name="projectId" value={project.id} />
                <RelationshipFields id="attach-project-contact" people={contacts} />
              </FormDialog>
            </span>
          </div>

          {people.length === 0 ? (
            <p className={styles.empty}>Nobody is listed on this work yet.</p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {people.map((row) => (
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
                      title={`${row.contactName} on ${project.name}`}
                      submitLabel="Save"
                      busyLabel="Saving"
                      variant="quiet"
                      action={updateProjectContactAction}
                    >
                      <input type="hidden" name="id" value={row.id} />
                      <input type="hidden" name="version" value={row.version} />
                      <RelationshipFields id={`project-rel-${row.id}`} hidePerson defaults={row} />
                    </FormDialog>
                    <RecordAction
                      action={detachProjectContactAction}
                      fields={{ id: row.id }}
                      label="Remove"
                      busyLabel="Removing"
                      confirm={`Remove ${row.contactName} from ${project.name}?`}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {lead ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Where it came from</h2>
            </div>
            <ul className={`${styles.list} ${styles.listThreeUp}`}>
              <li className={styles.row}>
                <span className={styles.rowPrimary}>
                  <Link className={styles.rowLink} href={`/studio/leads/${lead.id}`}>
                    {lead.title}
                  </Link>
                </span>
                <span className={styles.rowSecondary}>{label(lead.source)}</span>
                <span className={styles.rowMeta}>
                  {lead.convertedAt ? <Moment iso={lead.convertedAt.toISOString()} style="day" /> : null}
                </span>
              </li>
            </ul>
          </section>
        ) : null}

        {project.notes ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Notes</h2>
            </div>
            <p className={styles.prose}>{project.notes}</p>
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
