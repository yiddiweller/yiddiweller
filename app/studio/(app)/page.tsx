import { countInquiries, listRecentInquiries } from "@/lib/db/inquiries";
import { requireStaff } from "@/lib/auth/guard";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Home" };

function when(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Real data only. No invented charts, no placeholder metrics. Everything here
 * comes from records that already exist, which today means the person signed
 * in and the inquiries Build 001 started persisting.
 */
export default async function StudioHome() {
  const staff = await requireStaff();
  const [total, recent] = await Promise.all([countInquiries(), listRecentInquiries(5)]);

  return (
    <>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>{staff.name}</h1>
        <span className={styles.pageMeta}>{staff.role}</span>
      </div>

      <section className={styles.section}>
        <div className={styles.facts}>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Inquiries</span>
            <span className={styles.factValue}>{total}</span>
          </div>
          <div className={styles.fact}>
            <span className={styles.factLabel}>Latest</span>
            <span className={styles.factValue}>
              {recent[0] ? when(recent[0].createdAt) : "None yet"}
            </span>
          </div>
        </div>
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Recent inquiries</h2>
        </div>

        {recent.length === 0 ? (
          <p className={styles.empty}>
            Nothing has come through the contact form yet. It will appear here.
          </p>
        ) : (
          <ul className={styles.rows}>
            {recent.map((inquiry) => (
              <li key={inquiry.id} className={styles.row}>
                <span className={styles.rowPrimary}>{inquiry.name}</span>
                <span className={styles.rowSecondary}>{inquiry.preview}</span>
                <a className={styles.rowSecondary} href={`mailto:${inquiry.email}`}>
                  {inquiry.email}
                </a>
                <span className={styles.rowMeta}>{when(inquiry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
