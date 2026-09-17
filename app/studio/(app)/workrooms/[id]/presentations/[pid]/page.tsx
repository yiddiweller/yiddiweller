import Link from "next/link";
import { notFound } from "next/navigation";

import FormDialog from "@/components/studio/FormDialog";
import Moment from "@/components/studio/Moment";
import RecordAction from "@/components/studio/RecordAction";
import { currentStaff, requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import {
  filesToShareOnPublish,
  findPresentation,
  listDraftRows,
  listRevisions,
  presentableFiles,
  BODY_MAX,
  CAPTION_MAX,
  INTRO_MAX,
  TITLE_MAX,
} from "@/lib/db/presentations";
import { findWorkroom } from "@/lib/db/workrooms";
import { fileKind, formatBytes } from "@/lib/storage/policy";
import styles from "@/app/studio/studio.module.css";

import {
  addFileItemAction,
  addNoteItemAction,
  archivePresentationAction,
  moveItemAction,
  publishPresentationAction,
  removeItemAction,
  unpublishPresentationAction,
  updateItemAction,
  updatePresentationAction,
} from "../actions";

export const metadata = { title: "Presentation" };

/**
 * The draft editor.
 *
 * Everything here mutates the draft and nothing here reaches a client. The one
 * action that does is Publish, and what it will do — including which internal
 * files it will share — is spelled out beside the button rather than discovered
 * afterwards.
 *
 * Every control carries the **Presentation's** version. The draft is one
 * document: reordering it and rewording a note are edits to the same thing, so
 * a second person editing concurrently is told they lost rather than silently
 * winning half of it.
 */
export default async function StudioPresentation({
  params,
}: {
  params: Promise<{ id: string; pid: string }>;
}) {
  await requireStaff();
  const staff = await currentStaff();
  const { id, pid } = await params;
  if (!isId(id) || !isId(pid)) notFound();

  const [room, presentation] = await Promise.all([findWorkroom(id), findPresentation(pid)]);
  if (!room || !presentation || presentation.workroomId !== room.id) notFound();

  const [items, revisions, available, willShare] = await Promise.all([
    listDraftRows(presentation.id),
    listRevisions(presentation.id),
    presentableFiles(room.id),
    filesToShareOnPublish(presentation.id),
  ]);

  const used = new Set(items.map((item) => item.fileId).filter(Boolean));
  const addable = available.filter((file) => !used.has(file.id));
  const published = presentation.status === "published";
  const version = presentation.version;

  return (
    <>
      <Link className={styles.back} href={`/studio/workrooms/${room.id}/presentations`}>
        ← Presentations
      </Link>

      <header className={styles.pageHead}>
        <div className={styles.pageHeadText}>
          <h1 className={styles.pageTitle}>{presentation.title}</h1>
          <p className={styles.pageNote}>
            {published ? "Open to the client" : presentation.status === "unpublished" ? "Withdrawn" : "Draft"}
            {revisions.length > 0
              ? ` · ${revisions.length === 1 ? "1 version" : `${revisions.length} versions`} published`
              : " · never published"}
          </p>
        </div>

        <div className={styles.pageActions}>
          <Link
            className={styles.buttonSecondary}
            href={`/studio/workrooms/${room.id}/presentations/${presentation.id}/preview`}
          >
            Preview
          </Link>
        </div>
      </header>

      {/* The distinction that matters most on this page, said plainly rather
          than left to be inferred: after a publish, the draft and what the
          client is looking at are two different documents until the next one. */}
      {published && revisions.length > 0 ? (
        <div className={styles.notice} role="status">
          <p className={styles.noticeTitle}>
            The client is reading version {revisions[0].revisionNumber}.
          </p>
          <p>
            Editing below changes the draft and Preview. It does not change what the client sees —
            publishing again does, as version {revisions[0].revisionNumber + 1}.
          </p>
        </div>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Title and introduction</h2>
          <FormDialog
            trigger="Edit"
            title="Title and introduction"
            submitLabel="Save"
            busyLabel="Saving…"
            action={updatePresentationAction}
            variant="quiet"
          >
            <input type="hidden" name="id" value={presentation.id} />
            <input type="hidden" name="workroomId" value={room.id} />
            <input type="hidden" name="version" value={version} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="title">
                Title
              </label>
              <input
                id="title"
                className={styles.input}
                name="title"
                defaultValue={presentation.title}
                maxLength={TITLE_MAX}
                required
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="intro">
                Introduction
              </label>
              <textarea
                id="intro"
                className={styles.textarea}
                name="intro"
                rows={5}
                defaultValue={presentation.intro}
                maxLength={INTRO_MAX}
              />
            </div>
          </FormDialog>
        </div>
        {presentation.intro ? (
          <p className={styles.prose}>{presentation.intro}</p>
        ) : (
          <p className={styles.empty}>No introduction. The presentation opens straight into the work.</p>
        )}
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>The sequence</h2>
          <span className={styles.sectionNote}>
            {items.length === 0 ? "Empty" : `${items.length} blocks`}
          </span>
        </div>

        {items.length === 0 ? (
          <p className={styles.empty}>
            Nothing here yet. Add a file or some words below — a presentation of design work is
            files with words between them.
          </p>
        ) : (
          <div className={styles.list}>
            {items.map((item) => {
              const file = available.find((candidate) => candidate.id === item.fileId);

              return (
                <div key={item.id} className={styles.row}>
                  <span className={styles.rowPrimary}>
                    {item.kind === "file"
                      ? (file?.displayName ?? "A file that is no longer available")
                      : (item.caption ?? "Note")}
                  </span>
                  <span className={styles.rowSecondary}>
                    {item.kind === "file"
                      ? file
                        ? `${fileKind(file.contentType)} · ${formatBytes(file.byteSize ?? 0)}${item.caption ? ` · ${item.caption}` : ""}`
                        : "Remove this block before publishing"
                      : (item.body ?? "")}
                  </span>
                  <span className={styles.rowActions}>
                    {/* Reordering is two buttons, not a drag handle. A drag is
                        not reachable by keyboard and not comfortable on a
                        phone, and this list is short by design. */}
                    <RecordAction
                      action={moveItemAction}
                      fields={{
                        id: presentation.id,
                        workroomId: room.id,
                        version,
                        itemId: item.id,
                        direction: "up",
                      }}
                      label="Move up"
                      busyLabel="Moving…"
                    />
                    <RecordAction
                      action={moveItemAction}
                      fields={{
                        id: presentation.id,
                        workroomId: room.id,
                        version,
                        itemId: item.id,
                        direction: "down",
                      }}
                      label="Move down"
                      busyLabel="Moving…"
                    />

                    <FormDialog
                      trigger="Edit"
                      title={item.kind === "file" ? "The line under this file" : "This note"}
                      submitLabel="Save"
                      busyLabel="Saving…"
                      action={updateItemAction}
                      variant="quiet"
                    >
                      <input type="hidden" name="id" value={presentation.id} />
                      <input type="hidden" name="workroomId" value={room.id} />
                      <input type="hidden" name="version" value={version} />
                      <input type="hidden" name="itemId" value={item.id} />
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor={`caption-${item.id}`}>
                          {item.kind === "file" ? "Caption" : "Heading"}
                        </label>
                        <input
                          id={`caption-${item.id}`}
                          className={styles.input}
                          name="caption"
                          defaultValue={item.caption ?? ""}
                          maxLength={CAPTION_MAX}
                        />
                      </div>
                      {item.kind === "note" ? (
                        <div className={styles.field}>
                          <label className={styles.label} htmlFor={`body-${item.id}`}>
                            Words
                          </label>
                          <textarea
                            id={`body-${item.id}`}
                            className={styles.textarea}
                            name="body"
                            rows={6}
                            defaultValue={item.body ?? ""}
                            maxLength={BODY_MAX}
                            required
                          />
                        </div>
                      ) : null}
                    </FormDialog>

                    <RecordAction
                      action={removeItemAction}
                      fields={{
                        id: presentation.id,
                        workroomId: room.id,
                        version,
                        itemId: item.id,
                      }}
                      label="Remove"
                      busyLabel="Removing…"
                      confirm={{
                        title: "Remove this block?",
                        message:
                          "The draft loses it, along with anything written on it. Published versions keep it.",
                        action: "Remove",
                        destructive: true,
                      }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className={styles.actions}>
          <FormDialog
            trigger="Add a file"
            title="Add a file to this presentation"
            note="Files already in this workroom. Publishing shares whatever is in here."
            submitLabel="Add"
            busyLabel="Adding…"
            action={addFileItemAction}
            variant="secondary"
          >
            <input type="hidden" name="id" value={presentation.id} />
            <input type="hidden" name="workroomId" value={room.id} />
            <input type="hidden" name="version" value={version} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="fileId">
                File
              </label>
              <select id="fileId" className={styles.select} name="fileId" required>
                {addable.length === 0 ? <option value="">No files left to add</option> : null}
                {addable.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.displayName} — {fileKind(file.contentType)}
                    {file.visibility === "internal" ? " (internal)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="file-caption">
                Caption
              </label>
              <input
                id="file-caption"
                className={styles.input}
                name="caption"
                maxLength={CAPTION_MAX}
              />
              <p className={styles.hint}>Optional. The line the client reads under the work.</p>
            </div>
          </FormDialog>

          <FormDialog
            trigger="Add words"
            title="A note between the work"
            note="Context, or a section break. Not a page builder."
            submitLabel="Add"
            busyLabel="Adding…"
            action={addNoteItemAction}
            variant="secondary"
          >
            <input type="hidden" name="id" value={presentation.id} />
            <input type="hidden" name="workroomId" value={room.id} />
            <input type="hidden" name="version" value={version} />
            <div className={styles.field}>
              <label className={styles.label} htmlFor="note-caption">
                Heading
              </label>
              <input
                id="note-caption"
                className={styles.input}
                name="caption"
                maxLength={CAPTION_MAX}
              />
              <p className={styles.hint}>Optional.</p>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="note-body">
                Words
              </label>
              <textarea
                id="note-body"
                className={styles.textarea}
                name="body"
                rows={6}
                maxLength={BODY_MAX}
                required
              />
            </div>
          </FormDialog>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Publishing</h2>

        {/* The consequence, before the button rather than after it. Publishing
            shares what it references — that is what keeps one visibility rule
            true inside a version opened years later — and a consequence nobody
            was shown is not a consequence anybody chose. */}
        {willShare.length > 0 ? (
          <div className={styles.notice} role="status">
            <p className={styles.noticeTitle}>
              Publishing will also share {willShare.length === 1 ? "this file" : "these files"} with
              the client:
            </p>
            <ul className={styles.prose}>
              {willShare.map((file) => (
                <li key={file.id}>{file.displayName}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className={styles.actions}>
          <RecordAction
            action={publishPresentationAction}
            fields={{ id: presentation.id, workroomId: room.id, version }}
            label={revisions.length === 0 ? "Publish" : "Publish a new version"}
            busyLabel="Publishing…"
            variant="primary"
            /* The consequence is the message, and the count is the whole of
               it: publishing shares what it references, and somebody about to
               hand three files to a client should read the number three. */
            confirm={{
              title: revisions.length === 0 ? "Publish presentation?" : "Publish a new version?",
              message:
                willShare.length > 0
                  ? `${willShare.length === 1 ? "One file" : `${willShare.length} files`} will also be shared with the client.`
                  : revisions.length === 0
                    ? "The client can open it from that moment."
                    : "The client will see this instead of the current version.",
              action: "Publish",
            }}
          />

          {published ? (
            <RecordAction
              action={unpublishPresentationAction}
              fields={{ id: presentation.id, workroomId: room.id, version }}
              label="Withdraw"
              busyLabel="Withdrawing…"
              variant="secondary"
              confirm={{
                title: "Withdraw this presentation?",
                message:
                  "The client loses it and every earlier version. Nothing is deleted, and its files stay shared.",
                action: "Withdraw",
                destructive: true,
              }}
            />
          ) : null}

          {staff?.role === "owner" && !published ? (
            <RecordAction
              action={archivePresentationAction}
              fields={{ id: presentation.id, workroomId: room.id, version }}
              label="Archive"
              busyLabel="Archiving…"
              confirm={{
                title: "Archive this presentation?",
                message: "It leaves the workroom and stays in the record.",
                action: "Archive",
              }}
            />
          ) : null}
        </div>

        <p className={styles.hint}>
          Publishing sends no email. Telling the client is a separate decision.
        </p>
      </section>

      {revisions.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Versions</h2>
          <div className={styles.list}>
            {revisions.map((revision) => (
              <div key={revision.id} className={styles.row}>
                <span className={styles.rowPrimary}>
                  <Link
                    className={styles.rowLink}
                    href={`/studio/workrooms/${room.id}/presentations/${presentation.id}/revisions/${revision.revisionNumber}`}
                  >
                    Version {revision.revisionNumber}
                  </Link>
                </span>
                <span className={styles.rowSecondary}>
                  Published by {revision.publishedByName ?? "the studio"}
                </span>
                <span className={styles.rowMeta}>
                  <Moment iso={revision.publishedAt.toISOString()} />
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
