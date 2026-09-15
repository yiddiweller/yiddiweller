import InviteForm from "@/components/studio/InviteForm";
import StaffAction from "@/components/studio/StaffActions";
import { requireStaff } from "@/lib/auth/guard";
import { listOpenInvitations, listStaff } from "@/lib/db/staff";
import styles from "@/app/studio/studio.module.css";

import { deactivateStaff, reactivateStaff, revokeStaffInvitation } from "./actions";

export const metadata = { title: "Team" };

function when(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" })
    .format(date);
}

export default async function StudioTeam() {
  const viewer = await requireStaff();
  const isOwner = viewer.role === "owner";

  // Members see who is on the team. Invitations are access management, so they
  // are fetched only for an Owner rather than fetched and then hidden.
  const [staff, invitations] = await Promise.all([
    listStaff(),
    isOwner ? listOpenInvitations() : Promise.resolve([]),
  ]);

  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Team</h1>
        <span className={styles.pageMeta}>
          {staff.filter((person) => person.status === "active").length} active
        </span>
      </div>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Members</h2>
        </div>
        <ul className={styles.rows}>
          {staff.map((person) => (
            <li key={person.id} className={styles.row}>
              <span className={styles.rowPrimary}>{person.name}</span>
              <span className={styles.rowSecondary}>{person.email}</span>
              <span className={styles.rowMeta}>
                <span className={person.role === "owner" ? styles.tagStrong : styles.tag}>
                  {person.role}
                </span>
                {person.status === "inactive" ? <span className={styles.tag}> inactive</span> : null}
              </span>
              <span className={styles.rowMeta}>
                {isOwner && person.id !== viewer.id ? (
                  person.status === "active" ? (
                    <StaffAction
                      action={deactivateStaff}
                      id={person.id}
                      label="Deactivate"
                      busyLabel="Deactivating"
                    />
                  ) : (
                    <StaffAction
                      action={reactivateStaff}
                      id={person.id}
                      label="Reactivate"
                      busyLabel="Reactivating"
                    />
                  )
                ) : (
                  when(person.createdAt)
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {isOwner ? (
        <>
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Open invitations</h2>
            </div>
            {invitations.length === 0 ? (
              <p className={styles.empty}>No invitations are waiting.</p>
            ) : (
              <ul className={styles.rows}>
                {invitations.map((invite) => (
                  <li key={invite.id} className={styles.row}>
                    <span className={styles.rowPrimary}>{invite.email}</span>
                    <span className={styles.rowSecondary}>
                      <span className={styles.tag}>{invite.role}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      {invite.expired ? "Expired" : `Expires ${when(invite.expiresAt)}`}
                    </span>
                    <span className={styles.rowMeta}>
                      <StaffAction
                        action={revokeStaffInvitation}
                        id={invite.id}
                        label="Revoke"
                        busyLabel="Revoking"
                      />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Invite someone</h2>
            </div>
            <InviteForm />
          </section>
        </>
      ) : null}
    </>
  );
}
