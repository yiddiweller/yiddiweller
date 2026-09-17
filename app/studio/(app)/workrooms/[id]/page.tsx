import Link from "next/link";
import { notFound } from "next/navigation";

import AuditTrail from "@/components/studio/AuditTrail";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import WorkroomFields from "@/components/studio/WorkroomFields";
import { requireStaff } from "@/lib/auth/guard";
import { isId, label } from "@/lib/business";
import { listActivity } from "@/lib/db/activity";
import { listEntityAudit } from "@/lib/db/audit";
import { listFiles, workroomBytes } from "@/lib/db/files";
import { listPresentations } from "@/lib/db/presentations";
import {
  findWorkroom,
  invitableContacts,
  listOpenInvitations,
  listWorkroomMembers,
} from "@/lib/db/workrooms";
import { formatBytes } from "@/lib/storage/policy";
import { toClientActivity } from "@/lib/workrooms/view";
import styles from "@/app/studio/studio.module.css";

import {
  archiveWorkroomAction,
  inviteToWorkroomAction,
  publishWorkroomAction,
  resendWorkroomInvitationAction,
  restoreMembershipAction,
  restoreWorkroomAction,
  revokeMembershipAction,
  revokeWorkroomInvitationAction,
  setIdentityStatusAction,
  unpublishWorkroomAction,
  updateWorkroomAction,
} from "../actions";

export const metadata = { title: "Workroom" };

const STATE: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  unpublished: "Unpublished",
};

/**
 * Managing one Workroom: what the client will see, who may see it, and the two
 * records of everything that has happened to it.
 *
 * `requireStaff` runs inside this component, before the first read. Archiving
 * and switching a person's sign-in off are Owner-only and their controls are
 * not rendered for anybody else — the actions re-check regardless.
 */
export default async function StudioWorkroom({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const room = await findWorkroom(id);
  if (!room) notFound();

  const isOwner = viewer.role === "owner";
  const [members, invitations, invitable, activity, history, files, stored, presentations] =
    await Promise.all([
    listWorkroomMembers(id),
    listOpenInvitations(id),
    invitableContacts(id),
    listActivity(id, 20),
    isOwner ? listEntityAudit("workroom", id) : Promise.resolve([]),
    listFiles(id),
    workroomBytes(id),
    listPresentations(id),
  ]);

  const timeline = toClientActivity(activity);
  const live = room.status === "published" && !room.archivedAt;

  return (
    <>
      <Link className={styles.back} href="/studio/workrooms">
        ← Workrooms
      </Link>

      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {STATE[room.status]}
            {room.archivedAt ? " · Archived" : ""} · {room.clientName}
          </p>
          <h1 className={styles.pageTitle}>{room.title}</h1>
          <p className={styles.pageNote}>
            <Link className={styles.rowLink} href={`/studio/projects/${room.projectId}`}>
              {room.projectName}
            </Link>{" "}
            · {label(room.projectStatus)}
          </p>
        </div>

        <div className={styles.pageActions}>
          <Link className={styles.buttonSecondary} href={`/studio/workrooms/${room.id}/preview`}>
            Preview
          </Link>

          {!room.archivedAt ? (
            room.status === "published" ? (
              <RecordAction
                action={unpublishWorkroomAction}
                fields={{ id: room.id, version: room.version }}
                label="Unpublish"
                busyLabel="Unpublishing"
                confirm={`Unpublish ${room.title}? Its members lose access until it is published again. Nothing is deleted.`}
              />
            ) : (
              <RecordAction
                action={publishWorkroomAction}
                fields={{ id: room.id, version: room.version }}
                label="Publish"
                busyLabel="Publishing"
                variant="primary"
                confirm={`Publish ${room.title}? Everybody invited to it can open it from that moment.`}
              />
            )
          ) : null}

          <FormDialog
            trigger="Edit"
            title="What the client sees"
            note="The title and summary here are written for the client. Nothing from the project's own notes or description ever reaches them."
            submitLabel="Save"
            busyLabel="Saving"
            variant="quiet"
            action={updateWorkroomAction}
          >
            <input type="hidden" name="id" value={room.id} />
            <input type="hidden" name="version" value={room.version} />
            <WorkroomFields id="edit-workroom" defaults={room} />
          </FormDialog>

          {isOwner ? (
            room.archivedAt ? (
              <RecordAction
                action={restoreWorkroomAction}
                fields={{ id: room.id, version: room.version }}
                label="Restore"
                busyLabel="Restoring"
              />
            ) : (
              <RecordAction
                action={archiveWorkroomAction}
                fields={{ id: room.id, version: room.version }}
                label="Archive"
                busyLabel="Archiving"
                confirm={`Archive ${room.title}? Nothing is deleted.`}
              />
            )
          ) : null}
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section} aria-label="Overview">
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Members</span>
              <span className={styles.factValue}>{room.memberCount}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Waiting</span>
              <span className={styles.factValue}>{invitations.length}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Opened</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {room.publishedAt ? <Moment iso={room.publishedAt.toISOString()} style="day" /> : "Not yet"}
              </span>
            </div>
          </div>

          {room.summary ? (
            <p className={styles.prose}>{room.summary}</p>
          ) : (
            <p className={styles.empty}>
              No summary yet. This is the paragraph the client reads first — worth writing before
              you publish.
            </p>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Access</h2>
            <span className={styles.pageActions}>
              {live ? (
                <FormDialog
                  trigger="Invite somebody"
                  title={`Invite somebody to ${room.title}`}
                  note="Only people already connected to this client or project. If somebody is missing, add them as a contact first."
                  submitLabel="Send invitation"
                  busyLabel="Sending"
                  variant="quiet"
                  action={inviteToWorkroomAction}
                >
                  <input type="hidden" name="workroomId" value={room.id} />
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor="invite-contact">
                      Person
                    </label>
                    <select id="invite-contact" name="contactId" required className={styles.select}>
                      <option value="">Choose somebody</option>
                      {invitable.map((person) => (
                        <option key={person.id} value={person.id}>
                          {person.name} — {person.accessEmail ?? person.email}
                        </option>
                      ))}
                    </select>
                    <p className={styles.hint}>
                      Where somebody has signed in before, the invitation goes to the address they
                      verified, not to whatever their contact record says now. Changing a contact&rsquo;s
                      email never moves their access.
                    </p>
                  </div>
                </FormDialog>
              ) : null}
            </span>
          </div>

          {!live && !room.archivedAt ? (
            <div className={styles.notice}>
              <p className={styles.noticeTitle}>Nobody can open this yet.</p>
              <p>
                Invitations can be sent once it is published — a link into an unpublished workroom
                would not work.
              </p>
            </div>
          ) : null}

          {members.length === 0 && invitations.length === 0 ? (
            <p className={styles.empty}>Nobody has been invited.</p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {members.map((member) => (
                <li
                  key={member.id}
                  className={`${styles.row} ${member.status === "revoked" ? styles.rowMuted : ""}`}
                >
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/contacts/${member.contactId}`}>
                      {member.contactName}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    {member.accessEmail ?? member.contactEmail ?? "—"}
                  </span>
                  <span className={styles.rowMeta}>
                    {member.status === "active" ? (
                      <span className={`${styles.tag} ${styles.tagStrong}`}>Has access</span>
                    ) : (
                      <span className={styles.tag}>Revoked</span>
                    )}
                    {member.identityStatus === "inactive" ? (
                      <span className={styles.tag}> Sign-in off</span>
                    ) : null}
                  </span>
                  <span className={styles.rowActions}>
                    {member.status === "active" ? (
                      <RecordAction
                        action={revokeMembershipAction}
                        fields={{ id: member.id, version: member.version, workroomId: room.id }}
                        label="Take away access"
                        busyLabel="Working"
                        confirm={`Take away ${member.contactName}'s access to ${room.title}? It stops on their next click. Their other workrooms are untouched.`}
                      />
                    ) : (
                      <RecordAction
                        action={restoreMembershipAction}
                        fields={{ id: member.id, version: member.version, workroomId: room.id }}
                        label="Give it back"
                        busyLabel="Working"
                      />
                    )}
                    {isOwner && member.identityId ? (
                      <RecordAction
                        action={setIdentityStatusAction}
                        fields={{
                          identityId: member.identityId,
                          workroomId: room.id,
                          status: member.identityStatus === "inactive" ? "active" : "inactive",
                        }}
                        label={member.identityStatus === "inactive" ? "Turn sign-in on" : "Turn sign-in off"}
                        busyLabel="Working"
                        confirm={
                          member.identityStatus === "inactive"
                            ? undefined
                            : `Switch off ${member.contactName}'s sign-in? This ends every session they have, in every workroom.`
                        }
                      />
                    ) : null}
                  </span>
                </li>
              ))}

              {invitations.map((invite) => (
                <li key={invite.id} className={`${styles.row} ${invite.expired ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>{invite.contactName}</span>
                  <span className={styles.rowSecondary}>{invite.email}</span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{invite.expired ? "Expired" : "Invited"}</span>
                    {!invite.expired ? (
                      <span className={styles.rowMeta}>
                        {" "}
                        until <Moment iso={invite.expiresAt.toISOString()} style="day" />
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.rowActions}>
                    <RecordAction
                      action={resendWorkroomInvitationAction}
                      fields={{ id: invite.id, workroomId: room.id }}
                      label="Resend"
                      busyLabel="Sending"
                    />
                    <RecordAction
                      action={revokeWorkroomInvitationAction}
                      fields={{ id: invite.id, workroomId: room.id }}
                      label="Revoke"
                      busyLabel="Revoking"
                      confirm={`Revoke the invitation to ${invite.email}? Their link stops working straight away.`}
                    />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Presentations above Files, because a presentation is the thing the
            studio delivers and Files is the library underneath it. Managed on
            its own page; this is enough to know where the work stands. */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Presentations</h2>
            <Link className={styles.sectionNote} href={`/studio/workrooms/${room.id}/presentations`}>
              {presentations.length === 0 ? "Make one →" : `${presentations.length} →`}
            </Link>
          </div>
          {presentations.length === 0 ? (
            <p className={styles.empty}>
              Nothing yet. A presentation is how selected work is put in front of a client.
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listPair}`}>
              {presentations.slice(0, 3).map((presentation) => (
                <li key={presentation.id} className={styles.row}>
                  <span className={styles.rowSecondary}>{presentation.title}</span>
                  <span className={styles.rowMeta}>
                    {presentation.status === "published"
                      ? "Open to the client"
                      : presentation.status === "unpublished"
                        ? "Withdrawn"
                        : "Draft"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* A count and the three most recent, then a link. Files are managed on
            their own page; this is enough to know whether there are any. */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Files</h2>
            <Link className={styles.sectionNote} href={`/studio/workrooms/${room.id}/files`}>
              {files.length === 0
                ? "Add one →"
                : `${files.length} · ${formatBytes(stored)} →`}
            </Link>
          </div>
          {files.length === 0 ? (
            <p className={styles.empty}>
              Nothing yet. Files added here stay internal until they are shared.
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listPair}`}>
              {files.slice(0, 3).map((file) => (
                <li key={file.id} className={styles.row}>
                  <span className={styles.rowSecondary}>{file.displayName}</span>
                  <span className={styles.rowMeta}>
                    {file.visibility === "shared" ? "Shared" : "Internal"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Activity</h2>
            <span className={styles.sectionNote}>Exactly what the client can see</span>
          </div>
          {timeline.length === 0 ? (
            <p className={styles.empty}>Nothing yet.</p>
          ) : (
            <ul className={`${styles.list} ${styles.listPair}`}>
              {timeline.map((event) => (
                <li key={event.id} className={styles.row}>
                  <Moment className={styles.rowMeta} iso={event.occurredAt} />
                  <span className={styles.rowSecondary}>{event.text}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {isOwner ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>History</h2>
              <span className={styles.sectionNote}>Internal. What changed, never what it said</span>
            </div>
            <AuditTrail events={history} />
          </section>
        ) : null}
      </div>
    </>
  );
}
