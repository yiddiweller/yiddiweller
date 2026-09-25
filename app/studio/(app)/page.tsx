import Link from "next/link";

import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import { requireStaff } from "@/lib/auth/guard";
import { label } from "@/lib/business";
import { listClients } from "@/lib/db/clients";
import { countInquiries } from "@/lib/db/inquiries";
import {
  countInquiriesAwaitingLead,
  inquiriesAwaitingLead,
  leadsNeedingAttention,
  listLeads,
} from "@/lib/db/leads";
import { countLiveProjects, overdueProjects } from "@/lib/db/projects";
import { formatDate } from "@/lib/studio-format";
import styles from "@/app/studio/studio.module.css";

import { createLeadFromInquiryAction } from "./leads/actions";

export const metadata = { title: "Home" };

/**
 * The first operating screen.
 *
 * Real data only, and "needs attention" means a condition that is actually
 * true of a row: an inquiry with no lead behind it, a follow-up whose time has
 * passed, live work past its target date. Nothing here is a flag somebody has
 * to remember to set, so none of it can quietly become a lie. When there is
 * nothing to attend to, the section is not rendered at all rather than showing
 * an encouraging empty state nobody asked for.
 */
export default async function StudioHome() {
  const staff = await requireStaff();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const [
    inquiries,
    awaitingCount,
    awaiting,
    dueLeads,
    overdue,
    openLeads,
    liveProjects,
    clients,
  ] = await Promise.all([
    countInquiries(),
    countInquiriesAwaitingLead(),
    inquiriesAwaitingLead(5),
    leadsNeedingAttention(now, 5),
    overdueProjects(today, 5),
    listLeads({ open: true, pageSize: 1 }),
    countLiveProjects(),
    listClients({ pageSize: 1 }),
  ]);

  const attention = awaiting.length + dueLeads.length + overdue.length;

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
              <span className={styles.factLabel}>Open leads</span>
              <span className={styles.factValue}>{openLeads.total}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Live work</span>
              <span className={styles.factValue}>{liveProjects}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Clients</span>
              <span className={styles.factValue}>{clients.total}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Inquiries</span>
              <span className={styles.factValue}>{inquiries}</span>
            </div>
          </div>
        </section>

        {attention > 0 ? (
          <section className={styles.section}>
            <div className={styles.sectionHead}>
              <h2 className={styles.sectionTitle}>Needs attention</h2>
              <span className={styles.sectionNote}>
                {attention} {attention === 1 ? "thing" : "things"}
              </span>
            </div>

            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {awaiting.map((inquiry) => (
                <li key={inquiry.id} className={styles.row}>
                  <span className={styles.rowPrimary}>{inquiry.name}</span>
                  <span className={styles.rowSecondary}>
                    <a className={styles.rowLink} href={`mailto:${inquiry.email}`}>
                      {inquiry.email}
                    </a>
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>Inquiry, no lead</span>
                  </span>
                  <span className={styles.rowActions}>
                    <RecordAction
                      action={createLeadFromInquiryAction}
                      fields={{ inquiryId: inquiry.id }}
                      label="Make a lead"
                      busyLabel="Making"
                    />
                  </span>
                </li>
              ))}

              {dueLeads.map((lead) => (
                <li key={lead.id} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/leads/${lead.id}`}>
                      {lead.title}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    {lead.nextStep || lead.clientName || lead.prospectName || "—"}
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>Follow up due</span>
                  </span>
                  <Moment className={styles.rowMeta} iso={lead.followUpAt!.toISOString()} style="compact" />
                </li>
              ))}

              {overdue.map((project) => (
                <li key={project.id} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/projects/${project.id}`}>
                      {project.name}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>{project.clientName}</span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>Past target</span>
                    <span className={styles.tag}> {label(project.status)}</span>
                  </span>
                  <span className={styles.rowMeta}>{formatDate(project.targetOn, "compactDay")}</span>
                </li>
              ))}
            </ul>

            {awaitingCount > awaiting.length ? (
              <p className={styles.hint}>
                {awaitingCount - awaiting.length} more inquiries are waiting on a decision.
              </p>
            ) : null}
          </section>
        ) : null}

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2 className={styles.sectionTitle}>Where things are</h2>
          </div>
          <div className={styles.chips}>
            <Link className={styles.chip} href="/studio/leads">
              Pipeline
            </Link>
            <Link className={styles.chip} href="/studio/projects">
              Work
            </Link>
            <Link className={styles.chip} href="/studio/clients">
              Clients
            </Link>
            <Link className={styles.chip} href="/studio/search">
              Search
            </Link>
          </div>
        </section>
      </div>
    </>
  );
}
