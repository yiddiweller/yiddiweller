import Link from "next/link";
import { notFound } from "next/navigation";

import FileUpload from "@/components/studio/FileUpload";
import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { listFiles, workroomBytes } from "@/lib/db/files";
import { findWorkroom } from "@/lib/db/workrooms";
import { bucketConfigured } from "@/lib/env";
import { fileKind, formatBytes, viewable, WORKROOM_SOFT_BYTES } from "@/lib/storage/policy";
import styles from "@/app/studio/studio.module.css";

import {
  archiveFileAction,
  renameFileAction,
  restoreFileAction,
  setFileVisibilityAction,
} from "./actions";

/**
 * Static, like every Workroom title in Studio.
 *
 * `generateMetadata` is a second render that the page's guard does not cover,
 * so a refused request still produces a title and that title travels inside the
 * refusal. The cheapest way to never leak one is to never build one from a
 * record. Measured in Build 003; see docs/studio.md.
 */
export const metadata = { title: "Files" };

/**
 * Every file in one Workroom — internal and shared, both.
 *
 * `requireStaff` runs here, inside the component, before the first read. There
 * is no `loading.tsx` above it: a Suspense boundary over a guarded page turns a
 * refusal into a 200.
 */
export default async function StudioWorkroomFiles({
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

  const [files, used] = await Promise.all([listFiles(id, { includeArchived: true }), workroomBytes(id)]);
  const live = files.filter((file) => !file.archivedAt);
  const archived = files.filter((file) => file.archivedAt);
  const storage = bucketConfigured();

  return (
    <>
      <Link className={styles.back} href={`/studio/workrooms/${room.id}`}>
        ← {room.title}
      </Link>

      <header className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>Files</h1>
        <p className={styles.pageMeta}>
          {live.length === 0 ? "Nothing yet" : `${live.length} in this workroom`} ·{" "}
          {formatBytes(used)} stored
        </p>
      </header>

      {!storage ? (
        <div className={styles.notice} role="status">
          <p className={styles.noticeTitle}>Storage is not configured here.</p>
          <p>
            The five bucket variables are absent, so files cannot be uploaded or downloaded in this
            environment. Everything else in Studio is unaffected.
          </p>
        </div>
      ) : null}

      {used > WORKROOM_SOFT_BYTES ? (
        <div className={styles.notice} role="status">
          <p className={styles.noticeTitle}>This workroom is holding a lot.</p>
          <p>
            Past {formatBytes(WORKROOM_SOFT_BYTES)}. Nothing is blocked and nothing will stop
            working — worth a look at what is still needed.
          </p>
        </div>
      ) : null}

      {storage ? (
        <section className={styles.section} aria-label="Add a file">
          <FileUpload workroomId={room.id} />
        </section>
      ) : null}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>In this workroom</h2>

        {live.length === 0 ? (
          <p className={styles.empty}>
            No files yet. Anything added here stays internal until it is shared.
          </p>
        ) : (
          <div className={styles.rows}>
            {live.map((file) => (
              <div key={file.id} className={styles.row}>
                <span className={styles.rowPrimary}>
                  {/* Staff recognise an image at a glance, internal ones
                      included — that is most of why a thumbnail earns its place
                      here. Decorative: the name is right beside it. */}
                  {file.previewKey ? (
                    <img
                      className={styles.rowThumb}
                      src={`/studio/workrooms/${room.id}/files/${file.publicId}/preview`}
                      alt=""
                      loading="lazy"
                    />
                  ) : null}
                  {file.displayName}
                </span>
                <span className={styles.rowSecondary}>
                  {fileKind(file.contentType)} · {formatBytes(file.byteSize ?? 0)}
                  {file.supersedesFileId ? " · replaces an earlier file" : ""}
                </span>
                <span className={styles.rowMeta}>
                  <span className={file.visibility === "shared" ? styles.tagStrong : styles.tag}>
                    {file.visibility === "shared" ? "Shared" : "Internal"}
                  </span>{" "}
                  <Moment iso={file.createdAt.toISOString()} />
                </span>

                <span className={styles.rowActions}>
                  {/* Open first where there is something to open, so staff
                      check what a client will see without leaving Studio and
                      without downloading it. Internal files included: that is
                      most of the point of inspecting one. */}
                  {viewable(file.contentType) ? (
                    <Link
                      className={styles.buttonQuiet}
                      href={`/studio/workrooms/${room.id}/files/${file.publicId}`}
                    >
                      Open
                    </Link>
                  ) : null}
                  <a
                    className={styles.buttonQuiet}
                    href={`/studio/workrooms/${room.id}/files/${file.publicId}/download`}
                  >
                    Download
                  </a>

                  <FormDialog
                    trigger="Rename"
                    title="Rename this file"
                    submitLabel="Save"
                    busyLabel="Saving…"
                    action={renameFileAction}
                  >
                    <input type="hidden" name="id" value={file.id} />
                    <input type="hidden" name="workroomId" value={room.id} />
                    <input type="hidden" name="version" value={file.version} />
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`name-${file.id}`}>
                        Name the client sees
                      </label>
                      <input
                        id={`name-${file.id}`}
                        className={styles.input}
                        name="displayName"
                        defaultValue={file.displayName}
                        maxLength={200}
                        required
                      />
                    </div>
                  </FormDialog>

                  <RecordAction
                    action={setFileVisibilityAction}
                    fields={{
                      id: file.id,
                      workroomId: room.id,
                      version: file.version,
                      visibility: file.visibility === "shared" ? "internal" : "shared",
                    }}
                    label={file.visibility === "shared" ? "Stop sharing" : "Share"}
                    busyLabel="Saving…"
                    confirm={
                      file.visibility === "shared"
                        ? "Stop sharing this file? The client will no longer see it."
                        : undefined
                    }
                  />

                  {staff?.role === "owner" ? (
                    <RecordAction
                      action={archiveFileAction}
                      fields={{ id: file.id, workroomId: room.id, version: file.version }}
                      label="Archive"
                      busyLabel="Archiving…"
                      confirm="Archive this file? It stays in the record and leaves the workroom."
                    />
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {archived.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Archived</h2>
          <div className={styles.rows}>
            {archived.map((file) => (
              <div key={file.id} className={styles.row}>
                <span className={styles.rowPrimary}>{file.displayName}</span>
                <span className={styles.rowSecondary}>
                  {fileKind(file.contentType)} · {formatBytes(file.byteSize ?? 0)}
                </span>
                <span className={styles.rowMeta}>
                  <Moment iso={file.archivedAt!.toISOString()} />
                </span>
                <span className={styles.rowActions}>
                  {staff?.role === "owner" ? (
                    <RecordAction
                      action={restoreFileAction}
                      fields={{ id: file.id, workroomId: room.id, version: file.version }}
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
