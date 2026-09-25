import Link from "next/link";

import ClientFields from "@/components/studio/ClientFields";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import Pager from "@/components/studio/Pager";
import { requireStaff } from "@/lib/auth/guard";
import { LIMITS, PAGE_SIZE, label, readPage, text } from "@/lib/business";
import { listClients } from "@/lib/db/clients";
import { CLIENT_STATUSES } from "@/lib/db/schema";
import styles from "@/app/studio/studio.module.css";

import { createClientAction } from "./actions";

export const metadata = { title: "Clients" };

/**
 * Who the studio works for.
 *
 * The filters are a plain GET form and the archive toggle is a link, so every
 * view of this list is a URL: it survives a reload, it can be sent to somebody,
 * and it works before any JavaScript arrives. Filtering, sorting and paging all
 * happen in PostgreSQL — the list does not assume there will only ever be
 * twenty clients.
 */
export default async function StudioClients({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; archived?: string; page?: string }>;
}) {
  await requireStaff();

  const params = await searchParams;
  const query = text(params.q, LIMITS.search);
  const status = CLIENT_STATUSES.find((value) => value === params.status) ?? null;
  const archived = params.archived === "archived" ? "archived" : "active";
  const page = readPage(params.page);

  const { rows, total } = await listClients({
    query: query || undefined,
    status,
    archived,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {total} {total === 1 ? "client" : "clients"}
            {archived === "archived" ? " archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>Clients</h1>
        </div>
        <div className={styles.pageActions}>
          <FormDialog
            trigger="New client"
            title="New client"
            note="A client is the business relationship. The people are contacts, and they are added next."
            submitLabel="Add client"
            busyLabel="Adding"
            action={createClientAction}
          >
            <ClientFields id="new-client" />
          </FormDialog>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <form className={styles.filters} method="get" action="/studio/clients">
            <div className={`${styles.filterField} ${styles.filterWide}`}>
              <label className={styles.label} htmlFor="clients-q">
                Search
              </label>
              <input
                id="clients-q"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={LIMITS.search}
                placeholder="Name or domain"
                className={styles.input}
              />
            </div>

            <div className={styles.filterField}>
              <label className={styles.label} htmlFor="clients-status">
                Status
              </label>
              <select id="clients-status" name="status" defaultValue={status ?? ""} className={styles.select}>
                <option value="">Any</option>
                {CLIENT_STATUSES.map((value) => (
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
              href={`/studio/clients${query ? `?q=${encodeURIComponent(query)}` : ""}`}
            >
              Active
            </Link>
            <Link
              className={`${styles.chip} ${archived === "archived" ? styles.chipActive : ""}`}
              href={`/studio/clients?archived=archived${query ? `&q=${encodeURIComponent(query)}` : ""}`}
            >
              Archived
            </Link>
          </div>

          {rows.length === 0 ? (
            <p className={styles.empty}>
              {query || status
                ? "Nothing matches that. Try a shorter search, or clear the filters."
                : archived === "archived"
                  ? "Nothing has been archived."
                  : "No clients yet. The first one is usually a lead that came good."}
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {rows.map((client) => (
                <li key={client.id} className={`${styles.row} ${client.archivedAt ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/clients/${client.id}`}>
                      {client.name}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    {client.primaryContactName ?? client.domain ?? "—"}
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{label(client.accountType)}</span>
                    {client.status === "inactive" ? <span className={styles.tag}> Inactive</span> : null}
                    {client.liveProjects > 0 ? (
                      <span className={styles.tag}>
                        {" "}
                        {client.liveProjects} live
                      </span>
                    ) : null}
                  </span>
                  <Moment className={styles.rowMeta} iso={client.updatedAt.toISOString()} style="compactDay" />
                </li>
              ))}
            </ul>
          )}

          <Pager
            path="/studio/clients"
            params={{ q: query, status: status ?? undefined, archived: archived === "archived" ? "archived" : undefined }}
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
          />
        </section>
      </div>
    </>
  );
}
