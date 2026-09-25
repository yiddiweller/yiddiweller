import Link from "next/link";

import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import Pager from "@/components/studio/Pager";
import ProjectFields from "@/components/studio/ProjectFields";
import { requireStaff } from "@/lib/auth/guard";
import { LIMITS, PAGE_SIZE, label, readPage, text } from "@/lib/business";
import { selectableClients } from "@/lib/db/clients";
import { listProjects } from "@/lib/db/projects";
import { PROJECT_STATUSES } from "@/lib/db/schema";
import { formatDate } from "@/lib/studio-format";
import { listStaff } from "@/lib/db/staff";
import styles from "@/app/studio/studio.module.css";

import { createProjectAction } from "./actions";

export const metadata = { title: "Projects" };

/** The work. Always for a client, which is the one thing about it that cannot change. */
export default async function StudioProjects({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; archived?: string; page?: string }>;
}) {
  await requireStaff();

  const params = await searchParams;
  const query = text(params.q, LIMITS.search);
  const status = PROJECT_STATUSES.find((value) => value === params.status) ?? null;
  const archived = params.archived === "archived" ? "archived" : "active";
  const page = readPage(params.page);

  const [{ rows, total }, clients, staff] = await Promise.all([
    listProjects({ query: query || undefined, status, archived, page, pageSize: PAGE_SIZE }),
    selectableClients(),
    listStaff(),
  ]);
  const active = staff.filter((person) => person.status === "active");

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>
            {total} {total === 1 ? "project" : "projects"}
            {archived === "archived" ? " archived" : ""}
          </p>
          <h1 className={styles.pageTitle}>Projects</h1>
        </div>
        <div className={styles.pageActions}>
          <FormDialog
            trigger="New project"
            title="New project"
            submitLabel="Add project"
            busyLabel="Adding"
            action={createProjectAction}
          >
            <ProjectFields id="new-project" people={active} clients={clients} />
          </FormDialog>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <form className={styles.filters} method="get" action="/studio/projects">
            <div className={`${styles.filterField} ${styles.filterWide}`}>
              <label className={styles.label} htmlFor="projects-q">
                Search
              </label>
              <input
                id="projects-q"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={LIMITS.search}
                placeholder="Project or client"
                className={styles.input}
              />
            </div>

            <div className={styles.filterField}>
              <label className={styles.label} htmlFor="projects-status">
                Status
              </label>
              <select
                id="projects-status"
                name="status"
                defaultValue={status ?? ""}
                className={styles.select}
              >
                <option value="">Any</option>
                {PROJECT_STATUSES.map((value) => (
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
              href={`/studio/projects${query ? `?q=${encodeURIComponent(query)}` : ""}`}
            >
              Active
            </Link>
            <Link
              className={`${styles.chip} ${archived === "archived" ? styles.chipActive : ""}`}
              href={`/studio/projects?archived=archived${query ? `&q=${encodeURIComponent(query)}` : ""}`}
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
                  : "No work yet. A project usually starts as a lead that was converted."}
            </p>
          ) : (
            <ul className={`${styles.list} ${styles.listFourUp}`}>
              {rows.map((project) => (
                <li key={project.id} className={`${styles.row} ${project.archivedAt ? styles.rowMuted : ""}`}>
                  <span className={styles.rowPrimary}>
                    <Link className={styles.rowLink} href={`/studio/projects/${project.id}`}>
                      {project.name}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    <Link className={styles.rowLink} href={`/studio/clients/${project.clientId}`}>
                      {project.clientName}
                    </Link>
                  </span>
                  <span className={styles.rowMeta}>
                    <span className={styles.tag}>{label(project.status)}</span>
                    {project.ownerName ? <span className={styles.tag}> {project.ownerName}</span> : null}
                  </span>
                  {project.targetOn ? (
                    <span className={styles.rowMeta}>Target {formatDate(project.targetOn, "compactDay")}</span>
                  ) : (
                    <Moment className={styles.rowMeta} iso={project.updatedAt.toISOString()} style="compactDay" />
                  )}
                </li>
              ))}
            </ul>
          )}

          <Pager
            path="/studio/projects"
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
