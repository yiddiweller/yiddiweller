import Link from "next/link";
import { notFound } from "next/navigation";

import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { listPresentations, revisionCounts, INTRO_MAX, TITLE_MAX } from "@/lib/db/presentations";
import { findWorkroom } from "@/lib/db/workrooms";
import styles from "@/app/studio/studio.module.css";

import { createPresentationAction, restorePresentationAction } from "./actions";

/**
 * Static, like every Workroom title in Studio.
 *
 * `generateMetadata` is a second render that the page's guard does not cover,
 * so a refused request still produces a title and that title travels inside the
 * refusal. The cheapest way to never leak one is to never build one from a
 * record. Measured in Build 003; see docs/studio.md.
 */
export const metadata = { title: "Presentations" };

/**
 * Every Presentation in one Workroom — draft, published and unpublished.
 *
 * `requireStaff` runs here, inside the component, before the first read. There
 * is no `loading.tsx` above it: a Suspense boundary over a guarded page turns a
 * refusal into a 200.
 */
export default async function StudioPresentations({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireStaff();
  const staff = await currentStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const room = await findWorkroom(id);
  if (!room) notFound();

  const all = await listPresentations(id, { includeArchived: true });
  const live = all.filter((presentation) => !presentation.archivedAt);
  const archived = all.filter((presentation) => presentation.archivedAt);
  const versions = await revisionCounts(all.map((presentation) => presentation.id));

  return (
    <>
      <Link className={styles.back} href={`/studio/workrooms/${room.id}`}>
        ← {room.title}
      </Link>

      <header className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <h1 className={styles.pageTitle}>Presentations</h1>
          <p className={styles.pageNote}>
            {live.length === 0 ? "Nothing yet" : `${live.length} in this workroom`}
          </p>
        </div>

        <div className={styles.pageActions}>
          <FormDialog
            trigger="New presentation"
            title="A new presentation"
            note="A draft. Nothing reaches the client until it is published."
            submitLabel="Create"
            busyLabel="Creating…"
            action={createPresentationAction}
          >
            <input type="hidden" name="workroomId" value={room.id} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="new-title">
                Title
              </label>
              <input
                id="new-title"
                className={styles.input}
                name="title"
                maxLength={TITLE_MAX}
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="new-intro">
                Introduction
              </label>
              <textarea
                id="new-intro"
                className={styles.textarea}
                name="intro"
                rows={4}
                maxLength={INTRO_MAX}
              />
              <p className={styles.hint}>Optional. The client reads this above the work.</p>
            </div>
          </FormDialog>
        </div>
      </header>

      <section className={styles.section}>
        {live.length === 0 ? (
          <p className={styles.empty}>
            No presentations yet. A presentation is how selected work is put in front of a client.
          </p>
        ) : (
          <div className={styles.list}>
            {live.map((presentation) => {
              const count = versions.get(presentation.id) ?? 0;

              return (
                <div key={presentation.id} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    <Link
                      className={styles.rowLink}
                      href={`/studio/workrooms/${room.id}/presentations/${presentation.id}`}
                    >
                      {presentation.title}
                    </Link>
                  </span>
                  <span className={styles.rowSecondary}>
                    {count === 0 ? "No versions published yet" : count === 1 ? "1 version" : `${count} versions`}
                  </span>
                  <span className={styles.rowMeta}>
                    <span
                      className={
                        presentation.status === "published" ? styles.tagStrong : styles.tag
                      }
                    >
                      {presentation.status === "published"
                        ? "Open to the client"
                        : presentation.status === "unpublished"
                          ? "Withdrawn"
                          : "Draft"}
                    </span>{" "}
                    {presentation.publishedAt ? <Moment iso={presentation.publishedAt.toISOString()} /> : null}
                  </span>
                  <span className={styles.rowActions}>
                    <Link
                      className={styles.buttonQuiet}
                      href={`/studio/workrooms/${room.id}/presentations/${presentation.id}`}
                    >
                      Open
                    </Link>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Archived</h2>
          <div className={styles.list}>
            {archived.map((presentation) => (
              <div key={presentation.id} className={styles.row}>
                <span className={styles.rowPrimary}>{presentation.title}</span>
                <span className={styles.rowMeta}>
                  <Moment iso={presentation.archivedAt!.toISOString()} />
                </span>
                <span className={styles.rowActions}>
                  {staff?.role === "owner" ? (
                    <RecordAction
                      action={restorePresentationAction}
                      fields={{
                        id: presentation.id,
                        workroomId: room.id,
                        version: presentation.version,
                      }}
                      label="Restore"
                      busyLabel="Restoring…"
                    />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
