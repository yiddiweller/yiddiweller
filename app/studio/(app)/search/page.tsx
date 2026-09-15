import Link from "next/link";

import { requireStaff } from "@/lib/auth/guard";
import { LIMITS, text } from "@/lib/business";
import { search, type SearchKind } from "@/lib/db/search";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Search" };

const KINDS: Record<SearchKind, string> = {
  client: "Client",
  contact: "Contact",
  lead: "Lead",
  project: "Project",
};

/**
 * One box across the business core.
 *
 * A GET form and a plain page, so a search is a URL somebody can keep. The work
 * is four small indexed queries in PostgreSQL — there is no search service to
 * keep in step, and at Studio's size there does not need to be.
 */
export default async function StudioSearch({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireStaff();

  const params = await searchParams;
  const query = text(params.q, LIMITS.search);
  const hits = query ? await search(query) : [];

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {query ? `${hits.length} ${hits.length === 1 ? "result" : "results"}` : "Everything"}
          </p>
          <h1 className={styles.pageTitle}>Search</h1>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <form className={styles.filters} method="get" action="/studio/search">
            <div className={`${styles.filterField} ${styles.filterWide}`}>
              <label className={styles.label} htmlFor="search-q">
                Clients, contacts, leads and projects
              </label>
              <input
                id="search-q"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={LIMITS.search}
                autoFocus
                placeholder="A name, an address, a title"
                className={styles.input}
              />
            </div>
            <button type="submit" className={styles.buttonSecondary}>
              Search
            </button>
          </form>

          {!query ? (
            <p className={styles.empty}>
              Two characters is enough. Archived records are left out.
            </p>
          ) : hits.length === 0 ? (
            <p className={styles.empty}>Nothing matches that.</p>
          ) : (
            <ul className={`${styles.list} ${styles.listThreeUp}`}>
              {hits.map((hit) => (
                <li key={`${hit.kind}-${hit.id}`} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={hit.href}>
                      {hit.label}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>{hit.detail ?? "—"}</span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{KINDS[hit.kind]}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
