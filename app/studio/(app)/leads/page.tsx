import Link from "next/link";

import FormDialog from "@/components/studio/FormDialog";
import LeadFields from "@/components/studio/LeadFields";
import Moment from "@/components/studio/Moment";
import Pager from "@/components/studio/Pager";
import { requireStaff } from "@/lib/auth/guard";
import { LIMITS, PAGE_SIZE, label, readPage, text } from "@/lib/business";
import { selectableClients } from "@/lib/db/clients";
import { selectableContacts } from "@/lib/db/contacts";
import { leadPipeline, listLeads } from "@/lib/db/leads";
import { LEAD_STAGES, type LeadStage } from "@/lib/db/schema";
import { listStaff } from "@/lib/db/staff";
import styles from "@/app/studio/studio.module.css";

import { createLeadAction } from "./actions";

export const metadata = { title: "Leads" };

/** The stages still being worked. Won and lost are outcomes, and live in the list. */
const OPEN_STAGES: LeadStage[] = ["new", "discovery", "proposal"];

/**
 * The pipeline, and the list behind it.
 *
 * The board is the default because the shape of the pipeline is the thing worth
 * seeing — how much is at each stage, and what has been sitting still. The list
 * is where everything is, including what was won and lost, and where it can be
 * filtered and paged.
 *
 * Both are URLs, so either can be linked to.
 */
export default async function StudioLeads({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    q?: string;
    stage?: string;
    archived?: string;
    page?: string;
  }>;
}) {
  await requireStaff();

  const params = await searchParams;
  const asList = params.view === "list";
  const query = text(params.q, LIMITS.search);
  const stage = LEAD_STAGES.find((value) => value === params.stage) ?? null;
  const archived = params.archived === "archived" ? "archived" : "active";
  const page = readPage(params.page);

  const [staff, clients, contacts] = await Promise.all([
    listStaff(),
    selectableClients(),
    selectableContacts(),
  ]);
  const active = staff.filter((person) => person.status === "active");

  const board = asList ? null : await leadPipeline(OPEN_STAGES);
  const list = asList
    ? await listLeads({
        query: query || undefined,
        stage,
        archived,
        page,
        pageSize: PAGE_SIZE,
      })
    : null;

  const open = board ? OPEN_STAGES.reduce((sum, key) => sum + (board[key]?.length ?? 0), 0) : 0;

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {asList ? `${list?.total ?? 0} in total` : `${open} open`}
          </p>
          <h1 className={styles.pageTitle}>Leads</h1>
        </div>
        <div className={styles.pageActions}>
          <FormDialog
            trigger="New lead"
            title="New lead"
            note="An opportunity. It does not need a client yet — that is what converting it is for."
            submitLabel="Add lead"
            busyLabel="Adding"
            action={createLeadAction}
          >
            <LeadFields id="new-lead" people={active} clients={clients} contacts={contacts} />
          </FormDialog>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <div className={styles.chips}>
            <Link className={`${styles.chip} ${!asList ? styles.chipActive : ""}`} href="/studio/leads">
              Pipeline
            </Link>
            <Link
              className={`${styles.chip} ${asList ? styles.chipActive : ""}`}
              href="/studio/leads?view=list"
            >
              Everything
            </Link>
          </div>

          {board ? (
            <div className={styles.board}>
              {OPEN_STAGES.map((key) => {
                const column = board[key] ?? [];
                return (
                  <div key={key} className={styles.column}>
                    <div className={styles.columnHead}>
                      <h2 className={styles.columnTitle}>{label(key)}</h2>
                      <span className={styles.columnCount}>{column.length}</span>
                    </div>

                    {column.length === 0 ? (
                      <p className={styles.cardMeta}>Nothing here</p>
                    ) : (
                      <ul className={styles.cards}>
                        {column.map((lead) => (
                          <li key={lead.id}>
                            <Link className={styles.cardLink} href={`/studio/leads/${lead.id}`}>
                              <article className={styles.card}>
                                <h3 className={styles.cardTitle}>{lead.title}</h3>
                                <p className={styles.cardLine}>
                                  {lead.clientName ?? lead.prospectName ?? lead.contactName ?? "No name yet"}
                                </p>
                                <p className={styles.cardMeta}>
                                  {lead.followUpAt ? (
                                    <>
                                      Follow up <Moment iso={lead.followUpAt.toISOString()} />
                                    </>
                                  ) : (
                                    (lead.nextStep || "No next step")
                                  )}
                                </p>
                              </article>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}

          {list ? (
            <>
              <form className={styles.filters} method="get" action="/studio/leads">
                <input type="hidden" name="view" value="list" />

                <div className={`${styles.filterField} ${styles.filterWide}`}>
                  <label className={styles.label} htmlFor="leads-q">
                    Search
                  </label>
                  <input
                    id="leads-q"
                    name="q"
                    type="search"
                    defaultValue={query}
                    maxLength={LIMITS.search}
                    placeholder="Title or prospect"
                    className={styles.input}
                  />
                </div>

                <div className={styles.filterField}>
                  <label className={styles.label} htmlFor="leads-stage">
                    Stage
                  </label>
                  <select id="leads-stage" name="stage" defaultValue={stage ?? ""} className={styles.select}>
                    <option value="">Any</option>
                    {LEAD_STAGES.map((value) => (
                      <option key={value} value={value}>
                        {label(value)}
                      </option>
                    ))}
                  </select>
                </div>

                {archived === "archived" ? <input type="hidden" name="archived" value="archived" /> : null}

                <button type="submit" className={styles.buttonSecondary}>
                  Filter
                </button>
              </form>

              <div className={styles.chips}>
                <Link
                  className={`${styles.chip} ${archived === "active" ? styles.chipActive : ""}`}
                  href="/studio/leads?view=list"
                >
                  Active
                </Link>
                <Link
                  className={`${styles.chip} ${archived === "archived" ? styles.chipActive : ""}`}
                  href="/studio/leads?view=list&archived=archived"
                >
                  Archived
                </Link>
              </div>

              {list.rows.length === 0 ? (
                <p className={styles.empty}>
                  {query || stage ? "Nothing matches that." : "No leads yet."}
                </p>
              ) : (
                <ul className={`${styles.list} ${styles.listFourUp}`}>
                  {list.rows.map((lead) => (
                    <li key={lead.id} className={`${styles.row} ${lead.archivedAt ? styles.rowMuted : ""}`}>
                      <span className={styles.rowPrimary}>
                        <Link className={styles.rowLink} href={`/studio/leads/${lead.id}`}>
                          {lead.title}
                        </Link>
                      </span>
                      <span className={styles.rowSecondary}>
                        {lead.clientName ?? lead.prospectName ?? lead.contactName ?? "—"}
                      </span>
                      <span className={styles.rowMeta}>
                        <span className={`${styles.tag} ${lead.stage === "won" ? styles.tagStrong : ""}`}>
                          {label(lead.stage)}
                        </span>
                        <span className={styles.tag}> {label(lead.source)}</span>
                      </span>
                      <Moment className={styles.rowMeta} iso={lead.updatedAt.toISOString()} style="day" />
                    </li>
                  ))}
                </ul>
              )}

              <Pager
                path="/studio/leads"
                params={{
                  view: "list",
                  q: query,
                  stage: stage ?? undefined,
                  archived: archived === "archived" ? "archived" : undefined,
                }}
                page={page}
                total={list.total}
                pageSize={PAGE_SIZE}
              />
            </>
          ) : null}
        </section>
      </div>
    </>
  );
}
