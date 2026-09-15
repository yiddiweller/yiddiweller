import AuditTrail from "@/components/studio/AuditTrail";
import Pager from "@/components/studio/Pager";
import { requireOwner } from "@/lib/auth/guard";
import { readPage } from "@/lib/business";
import { auditFilterOptions, listAuditEvents } from "@/lib/db/audit";
import { AUDIT_ENTITY_TYPES, type AuditEntityType } from "@/lib/db/schema";
import { describeAction } from "@/components/studio/AuditTrail";
import styles from "@/app/studio/studio.module.css";

export const metadata = { title: "Audit" };

const PAGE_SIZE = 50;

/**
 * Who changed what, and when.
 *
 * Owner-only, and `requireOwner` is called inside this component before the
 * first read — not in a parent layout, which would let the page fetch and ship
 * this data while the layout was still deciding. There is deliberately no
 * `loading.tsx` above it either: a Suspense boundary flushes the shell first,
 * after which a refusal can no longer set a status and arrives as 200. The
 * measurements behind both are in lib/auth/guard.ts.
 *
 * The log records that something changed, never what it now says. No notes, no
 * messages, no tokens — the policy is in docs/audit.md, and PostgreSQL refuses
 * to let any of it be rewritten.
 */
export default async function StudioAudit({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; entity?: string; action?: string; page?: string }>;
}) {
  await requireOwner();

  const params = await searchParams;
  const entityType = (AUDIT_ENTITY_TYPES.find((value) => value === params.entity) ??
    null) as AuditEntityType | null;
  const page = readPage(params.page);

  const [{ rows, total }, options] = await Promise.all([
    listAuditEvents({
      actorId: params.actor || null,
      entityType,
      action: params.action || null,
      page,
      pageSize: PAGE_SIZE,
    }),
    auditFilterOptions(),
  ]);

  return (
    <>
      <div className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <p className={styles.eyebrow}>{total} recorded</p>
          <h1 className={styles.pageTitle}>Audit</h1>
          <p className={styles.pageNote}>
            Append-only. Nothing here can be edited or removed, by anybody, including the database
            user the application connects as.
          </p>
        </div>
      </div>

      <div className={styles.sections}>
        <section className={styles.section}>
          <form className={styles.filters} method="get" action="/studio/audit">
            <div className={styles.filterField}>
              <label className={styles.label} htmlFor="audit-actor">
                Who
              </label>
              <select
                id="audit-actor"
                name="actor"
                defaultValue={params.actor ?? ""}
                className={styles.select}
              >
                <option value="">Anybody</option>
                {options.actors.map((actor) => (
                  <option key={actor.id} value={actor.id}>
                    {actor.name}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filterField}>
              <label className={styles.label} htmlFor="audit-entity">
                What
              </label>
              <select
                id="audit-entity"
                name="entity"
                defaultValue={entityType ?? ""}
                className={styles.select}
              >
                <option value="">Anything</option>
                {AUDIT_ENTITY_TYPES.map((value) => (
                  <option key={value} value={value}>
                    {value.replace("_", " ")}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.filterField}>
              <label className={styles.label} htmlFor="audit-action">
                Action
              </label>
              <select
                id="audit-action"
                name="action"
                defaultValue={params.action ?? ""}
                className={styles.select}
              >
                <option value="">Any</option>
                {options.actions.map((action) => (
                  <option key={action} value={action}>
                    {describeAction(action)}
                  </option>
                ))}
              </select>
            </div>

            <button type="submit" className={styles.buttonSecondary}>
              Filter
            </button>
          </form>

          {rows.length === 0 ? (
            <p className={styles.empty}>Nothing matches that.</p>
          ) : (
            <AuditTrail events={rows} showEntity />
          )}

          <Pager
            path="/studio/audit"
            params={{
              actor: params.actor || undefined,
              entity: entityType ?? undefined,
              action: params.action || undefined,
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
