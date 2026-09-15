import { countInquiries, listRecentInquiries } from "@/lib/db/inquiries";
import { requireStaff } from "@/lib/auth/guard";
import { whenExact } from "@/lib/studio-format";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Home" };

/**
 * The first operating screen.
 *
 * Real data only. Every figure here comes from a record that exists — the
 * person signed in, and the inquiries Build 001 started keeping. No invented
 * revenue, no placeholder chart, no fake activity feed. When Build 003 brings
 * clients, leads and projects, they arrive as further sections in this same
 * page architecture; they are not sketched in now.
 */
export default async function StudioHome() {
  const staff = await requireStaff();
  const [total, recent] = await Promise.all([countInquiries(), listRecentInquiries(5)]);
  const latest = recent[0];

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>Studio</p>
          <h1 className={styles.pageTitle}>{staff.name}</h1>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section} aria-label="Overview">
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Inquiries</span>
              <span className={styles.factValue}>{total}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Latest</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {latest ? whenExact(latest.createdAt) : "None yet"}
              </span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Your access</span>
              <span className={`${styles.factValue} ${styles.factValueSmall}`}>
                {staff.role === "owner" ? "Owner" : "Member"}
              </span>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Recent inquiries</h2>
            {total > recent.length ? (
              <span className={styles.sectionNote}>
                {recent.length} of {total}
              </span>
            ) : null}
          </div>

          {recent.length === 0 ? (
            <p className={styles.empty}>
              Nothing has come through the contact form yet. When someone writes in from
              yiddiweller.com, their message appears here.
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {recent.map((inquiry) => (
                <li key={inquiry.id} className={styles.row}>
                  <span className={styles.rowPrimary}>{inquiry.name}</span>
                  <span className={styles.rowPreview}>{inquiry.preview}</span>
                  <span className={styles.rowSecondary}>
                    <a className={styles.rowLink} href={`mailto:${inquiry.email}`}>
                      {inquiry.email}
                    </a>
                  </span>
                  <time className={styles.rowMeta} dateTime={inquiry.createdAt.toISOString()}>
                    {whenExact(inquiry.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
