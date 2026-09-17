import InviteDialog from "@/components/studio/InviteDialog";
import StaffAction from "@/components/studio/StaffActions";
import { requireStaff } from "@/lib/auth/guard";
import { listOpenInvitations, listStaff } from "@/lib/db/staff";
import Moment from "@/components/studio/Moment";
import styles from "@/app/studio/studio.module.css";

import { deactivateStaff, reactivateStaff, revokeStaffInvitation } from "./actions";

export const metadata = { title: "Team" };

/**
 * Who has access, and — for an Owner — the controls that change it.
 *
 * Members see the roster. Invitations are access management, so they are
 * fetched only for an Owner rather than fetched and then hidden in the markup
 * where anyone can read them. Every action re-checks the caller on the server
 * regardless; rendering is never the boundary.
 */
export default async function StudioTeam() {
  const viewer = await requireStaff();
  const isOwner = viewer.role === "owner";

  const [staff, invitations] = await Promise.all([
    listStaff(),
    isOwner ? listOpenInvitations() : Promise.resolve([]),
  ]);

  const active = staff.filter((person) => person.status === "active");

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {active.length} active {active.length === 1 ? "member" : "members"}
          </p>
          <h1 className={styles.pageTitle}>Team</h1>
        </div>
        {isOwner ? (
          <div className={styles.pageActions}>
            <InviteDialog />
          </div>
        ) : null}
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Members</h2>
          </div>

          <ul className={`${styles.list} ${styles.listFourUp}`}>
            {staff.map((person) => {
              const inactive = person.status === "inactive";
              return (
                <li
                  key={person.id}
                  className={`${styles.row} ${inactive ? styles.rowMuted : ""}`}
                >
                  <span className={styles.rowPrimary}>
                    {person.name}
                    {person.id === viewer.id ? (
                      <span className={styles.rowMeta}> — you</span>
                    ) : null}
                  </span>
                  <span className={styles.rowSecondary}>{person.email}</span>
                  <span className={styles.rowMeta}>
                    <span className={`${styles.tag} ${person.role === "owner" ? styles.tagStrong : ""}`}>
                      {person.role}
                    </span>
                    {inactive ? <span className={styles.tag}> Inactive</span> : null}
                  </span>
                  <span className={styles.rowActions}>
                    {isOwner && person.id !== viewer.id ? (
                      <StaffAction
                        action={inactive ? reactivateStaff : deactivateStaff}
                        id={person.id}
                        label={inactive ? "Restore access" : "Remove access"}
                        busyLabel={inactive ? "Restoring" : "Removing"}
                        confirm={
                          inactive
                            ? undefined
                            : {
                                title: `Remove ${person.name}'s access?`,
                                message:
                                  "They are signed out immediately and cannot sign back in.",
                                action: "Remove access",
                                destructive: true,
                              }
                        }
                      />
                    ) : (
                      <span className={styles.rowMeta}>
                        Since <Moment iso={person.createdAt.toISOString()} style="day" />
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        {isOwner ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Open invitations</h2>
              {invitations.length > 0 ? (
                <span className={styles.sectionNote}>Single use · seven days</span>
              ) : null}
            </div>

            {invitations.length === 0 ? (
              <p className={styles.empty}>
                No invitations are waiting. Someone you invite appears here until they accept.
              </p>
            ) : (
              <ul className={`${styles.list} ${styles.listFourUp}`}>
                {invitations.map((invite) => (
                  <li
                    key={invite.id}
                    className={`${styles.row} ${invite.expired ? styles.rowMuted : ""}`}
                  >
                    <span className={styles.rowPrimary}>{invite.email}</span>
                    <span className={styles.rowSecondary}>
                      Invited <Moment iso={invite.createdAt.toISOString()} style="day" />
                    </span>
                    <span className={styles.rowMeta}>
                      <span className={styles.tag}>{invite.role}</span>
                      {invite.expired ? <span className={styles.tag}> Expired</span> : null}
                    </span>
                    <span className={styles.rowActions}>
                      {!invite.expired ? (
                        <span className={styles.rowMeta}>
                          Expires <Moment iso={invite.expiresAt.toISOString()} style="day" />
                        </span>
                      ) : null}
                      <StaffAction
                        action={revokeStaffInvitation}
                        id={invite.id}
                        label={invite.expired ? "Remove" : "Revoke"}
                        busyLabel="Working"
                        confirm={
                          invite.expired
                            ? undefined
                            : {
                                title: `Revoke the invitation to ${invite.email}?`,
                                message: "Their link stops working straight away.",
                                action: "Revoke invitation",
                                destructive: true,
                              }
                        }
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </>
  );
}
