import Link from "next/link";

import Moment from "@/components/studio/Moment";
import Pager from "@/components/studio/Pager";
import { requireStaff } from "@/lib/auth/guard";
import { LIMITS, PAGE_SIZE, label, readPage, text } from "@/lib/business";
import { listWorkrooms } from "@/lib/db/workrooms";
import { WORKROOM_STATUSES } from "@/lib/db/schema";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Workrooms" };

const STATE: Record<string, string> = {
  draft: "Draft",
  published: "Published",
  unpublished: "Unpublished",
};

/**
 * Every client-facing space the studio has opened, and the ones it has not
 * opened yet.
 *
 * A Workroom is created from its Project — work exists before the room around
 * it does — so there is no "New workroom" button here. This is where they are
 * found afterwards.
 */
export default async function StudioWorkrooms({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; archived?: string; page?: string }>;
}) {
  await requireStaff();

  const params = await searchParams;
  const query = text(params.q, LIMITS.search);
  const status = WORKROOM_STATUSES.find((value) => value === params.status) ?? null;
  const archived = params.archived === "archived" ? "archived" : "active";
  const page = readPage(params.page);

  const { rows, total } = await listWorkrooms({
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
            {total} {total === 1 ? "workroom" : "workrooms"}
            {archived === "archived" ? " archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>Workrooms</h1>
          <p className={styles.pageNote}>
            A workroom is opened from its project. Publishing one is what a client can see.
          </p>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <form className={styles.filters} method="get" action="/studio/workrooms">
            <div className={`${styles.filterField} ${styles.filterWide}`}>
              <label className={styles.label} htmlFor="workrooms-q">
                Search
              </label>
              <input
                id="workrooms-q"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={LIMITS.search}
                placeholder="Workroom, project or client"
                className={styles.input}
              />
            </div>

            <div className={styles.filterField}>
              <label className={styles.label} htmlFor="workrooms-status">
                State
              </label>
              <select
                id="workrooms-status"
                name="status"
                defaultValue={status ?? ""}
                className={styles.select}
              >
                <option value="">Any</option>
                {WORKROOM_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {STATE[value]}
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
              href="/studio/workrooms"
            >
              Active
            </Link>
            <Link
              className={`${styles.chip} ${archived === "archived" ? styles.chipActive : ""}`}
              href="/studio/workrooms?archived=archived"
            >
              Archived
            </Link>
          </div>

          {rows.length === 0 ? (
            <p className={styles.empty}>
              {query || status
                ? "Nothing matches that."
                : archived === "archived"
                  ? "Nothing has been archived."
                  : "No workrooms yet. Open one from a project when there is something a client should see."}
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {rows.map((room) => (
                <li key={room.id} className={`${styles.row} ${room.archivedAt ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/workrooms/${room.id}`}>
                      {room.title}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    <Link className={styles.rowLink} href={`/studio/clients/${room.clientId}`}>
                      {room.clientName}
                    </Link>
                  </span>
                  <span className={styles.rowMeta}>
                    <span
                      className={`${styles.tag} ${room.status === "published" ? styles.tagStrong : ""}`}
                    >
                      {STATE[room.status]}
                    </span>
                    <span className={styles.tag}>
                      {" "}
                      {room.memberCount} {room.memberCount === 1 ? "member" : "members"}
                    </span>
                    <span className={styles.tag}> {label(room.projectStatus)}</span>
                  </span>
                  <Moment className={styles.rowMeta} iso={room.updatedAt.toISOString()} style="day" />
                </li>
              ))}
            </ul>
          )}

          <Pager
            path="/studio/workrooms"
            params={{
              q: query,
              status: status ?? undefined,
              archived: archived === "archived" ? "archived" : undefined,
            }}
            page={page}
            total={total}
            pageSize={PAGE_SIZE}
          />
        </section>
      </div>
    </>
  );
}
