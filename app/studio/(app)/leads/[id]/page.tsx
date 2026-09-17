import Link from "next/link";
import { notFound } from "next/navigation";

import AuditTrail from "@/components/studio/AuditTrail";
import FormDialog from "@/components/studio/FormDialog";
import LeadFields from "@/components/studio/LeadFields";
import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { LIMITS, isId, label } from "@/lib/business";
import { listEntityAudit } from "@/lib/db/audit";
import { selectableClients } from "@/lib/db/clients";
import { selectableContacts } from "@/lib/db/contacts";
import { findLead } from "@/lib/db/leads";
import { LEAD_STAGES, PROJECT_STATUSES } from "@/lib/db/schema";
import { listStaff } from "@/lib/db/staff";
import styles from "@/app/studio/studio.module.css";

import {
  archiveLeadAction,
  convertLeadAction,
  moveLeadAction,
  restoreLeadAction,
  updateLeadAction,
} from "../actions";

/** Stages somebody can move a lead to by hand. Won is reached by converting. */
const MOVABLE = LEAD_STAGES.filter((stage) => stage !== "won");

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
  if (!isId(id) || !(await currentStaff())) return { title: "Lead" };
  const record = await findLead(id);
  return { title: record?.title ?? "Lead" };
}

/**
 * One lead, and the two things that can happen to it: it moves, or it becomes
 * work.
 *
 * Converting is a single transaction — the client, the project, the
 * relationships and the lead itself, together or not at all — so the button
 * either lands all of it or writes nothing.
 */
export default async function StudioLead({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const lead = await findLead(id);
  if (!lead) notFound();

  const isOwner = viewer.role === "owner";
  const [staff, clients, contacts, history] = await Promise.all([
    listStaff(),
    selectableClients(),
    selectableContacts(),
    isOwner ? listEntityAudit("lead", id) : Promise.resolve([]),
  ]);
  const active = staff.filter((person) => person.status === "active");
  const converted = Boolean(lead.convertedAt);

  return (
    <>
      <Link className={styles.back} href="/studio/leads">
        ← Leads
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {label(lead.stage)} · {label(lead.source)}
            {lead.archivedAt ? " · Archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>{lead.title}</h1>
          <p className={styles.pageNote}>
            {lead.clientId ? (
              <Link className={styles.rowLink} href={`/studio/clients/${lead.clientId}`}>
                {lead.clientName}
              </Link>
            ) : (
              (lead.prospectName ?? "Not a client yet")
            )}
          </p>
        </div>

        <div className={styles.pageActions}>
          {!converted && !lead.archivedAt ? (
            <FormDialog
              trigger="Convert to project"
              title="Convert this lead"
              note="This creates the work, and the client if there is not one yet. It happens once."
              submitLabel="Convert"
              busyLabel="Converting"
              action={convertLeadAction}
            >
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="version" value={lead.version} />

              <div className={styles.field}>
                <label className={styles.label} htmlFor="convert-clientId">
                  Client
                </label>
                <select
                  id="convert-clientId"
                  name="clientId"
                  defaultValue={lead.clientId ?? ""}
                  className={styles.select}
                >
                  <option value="">Create a new client</option>
                  {clients.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="convert-newClientName">
                  New client name
                </label>
                <input
                  id="convert-newClientName"
                  name="newClientName"
                  maxLength={LIMITS.name}
                  defaultValue={lead.prospectName ?? lead.contactName ?? ""}
                  autoComplete="off"
                  className={styles.input}
                />
                <p className={styles.hint}>Used only if no existing client is chosen above.</p>
              </div>

              <div className={`${styles.field} ${styles.check}`}>
                <input id="convert-withProject" name="withProject" type="checkbox" defaultChecked />
                <label className={styles.label} htmlFor="convert-withProject">
                  Set the work up now
                </label>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="convert-projectName">
                  Project name
                </label>
                <input
                  id="convert-projectName"
                  name="projectName"
                  required
                  maxLength={LIMITS.name}
                  defaultValue={lead.title}
                  autoComplete="off"
                  className={styles.input}
                />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="convert-projectStatus">
                  Status
                </label>
                <select
                  id="convert-projectStatus"
                  name="projectStatus"
                  defaultValue="planned"
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
                <label className={styles.label} htmlFor="convert-ownerId">
                  Looked after by
                </label>
                <select
                  id="convert-ownerId"
                  name="ownerId"
                  defaultValue={lead.ownerId ?? ""}
                  className={styles.select}
                >
                  <option value="">Nobody yet</option>
                  {active.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="convert-startsOn">
                  Starts
                </label>
                <input id="convert-startsOn" name="startsOn" type="date" className={styles.input} />
              </div>

              <div className={styles.field}>
                <label className={styles.label} htmlFor="convert-targetOn">
                  Target
                </label>
                <input id="convert-targetOn" name="targetOn" type="date" className={styles.input} />
                <p className={styles.hint}>
                  Leave the work unticked to win the lead now and set the project up later.
                </p>
              </div>
            </FormDialog>
          ) : null}

          {!converted ? (
            <FormDialog
              trigger="Edit"
              title="Edit lead"
              submitLabel="Save"
              busyLabel="Saving"
              variant="secondary"
              action={updateLeadAction}
            >
              <input type="hidden" name="id" value={lead.id} />
              <input type="hidden" name="version" value={lead.version} />
              <LeadFields id="edit-lead" people={active} clients={clients} contacts={contacts} defaults={lead} />
            </FormDialog>
          ) : null}

          {isOwner ? (
            lead.archivedAt ? (
              <RecordAction
                action={restoreLeadAction}
                fields={{ id: lead.id, version: lead.version }}
                label="Restore"
                busyLabel="Restoring"
              />
            ) : (
              <RecordAction
                action={archiveLeadAction}
                fields={{ id: lead.id, version: lead.version }}
                label="Archive"
                busyLabel="Archiving"
                confirm={{
                  title: `Archive ${lead.title}?`,
                  message: "It leaves the pipeline. Nothing is deleted.",
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
              <span className={styles.factLabel}>Person</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {lead.contactId ? (
                  <Link className={styles.rowLink} href={`/studio/contacts/${lead.contactId}`}>
                    {lead.contactName}
                  </Link>
                ) : (
                  "—"
                )}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Looked after by</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {lead.ownerName ?? "Nobody yet"}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Follow up</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {lead.followUpAt ? <Moment iso={lead.followUpAt.toISOString()} /> : "Not set"}
              </span>
            </div>
          </div>
        </section>

        {converted ? (
          <section className={styles.section}>
            <div className={styles.notice}>
              <p className={styles.noticeTitle}>
                {lead.projectId ? "This lead became work." : "This lead was won."}
              </p>
              <p>
                Converted <Moment iso={lead.convertedAt!.toISOString()} />.{" "}
                {lead.projectId ? (
                  <Link className={styles.rowLink} href={`/studio/projects/${lead.projectId}`}>
                    Open the project
                  </Link>
                ) : (
                  <Link className={styles.rowLink} href={`/studio/clients/${lead.clientId}`}>
                    Open the client, where the work can be set up
                  </Link>
                )}
                .
              </p>
            </div>
          </section>
        ) : (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Stage</h2>
              <span className={styles.sectionNote}>Won is reached by converting</span>
            </div>

            <div className={styles.actions}>
              {MOVABLE.filter((stage) => stage !== lead.stage && stage !== "lost").map((stage) => (
                <RecordAction
                  key={stage}
                  action={moveLeadAction}
                  fields={{ id: lead.id, version: lead.version, stage }}
                  label={`Move to ${label(stage).toLowerCase()}`}
                  busyLabel="Moving"
                />
              ))}

              {lead.stage !== "lost" ? (
                // Lost is the one move worth a sentence, so it asks for one
                // rather than firing from a button. The reason is free text and
                // never reaches the audit log: see docs/audit.md.
                <FormDialog
                  trigger="Mark as lost"
                  title="Mark this lead as lost"
                  note="It stays in the list and can be reopened later."
                  submitLabel="Mark as lost"
                  busyLabel="Saving"
                  variant="quiet"
                  action={moveLeadAction}
                >
                  <input type="hidden" name="id" value={lead.id} />
                  <input type="hidden" name="version" value={lead.version} />
                  <input type="hidden" name="stage" value="lost" />
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="lost-reason">
                      Why
                    </label>
                    <input
                      id="lost-reason"
                      name="lostReason"
                      maxLength={LIMITS.lostReason}
                      placeholder="Chose somebody else, budget, timing"
                      autoComplete="off"
                      className={styles.input}
                    />
                  </div>
                </FormDialog>
              ) : null}
            </div>

            {lead.nextStep ? <p className={styles.hint}>Next: {lead.nextStep}</p> : null}
          </section>
        )}

        {lead.stage === "lost" && lead.lostReason ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Why it was lost</h2>
            </div>
            <p className={styles.prose}>{lead.lostReason}</p>
          </section>
        ) : null}

        {lead.summary ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Summary</h2>
            </div>
            <p className={styles.prose}>{lead.summary}</p>
          </section>
        ) : null}

        {lead.inquiryId ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Where it came from</h2>
            </div>
            <p className={styles.prose}>
              An inquiry through the contact form. The message itself stays on the inquiry — this
              lead is our reading of it, not a second copy.
            </p>
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
