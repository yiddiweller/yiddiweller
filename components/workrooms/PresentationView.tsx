import Link from "next/link";

import FileViewer from "@/components/workrooms/FileViewer";
import Moment from "@/components/studio/Moment";
import { type ClientPresentation } from "@/lib/workrooms/presentation-view";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * A Presentation, as the client reads it.
 *
 * **One component, rendered by three routes**: the client's current view, the
 * client's view of an earlier Revision, and the staff preview. `WorkroomOverview`
 * exists for the same reason and was written after the preview had already
 * silently fallen a feature behind the page it claimed to preview. There is no
 * second copy of this markup to forget.
 *
 * It receives a `ClientPresentation` — already whitelisted — and never a
 * database row, so it cannot leak a field it was not given. Everything visual
 * it needs is in that shape: the words, the order, and a `ClientFile` per file
 * item carrying our own authorized routes rather than any storage address.
 *
 * **Every file item renders through `FileViewer`**, the same component the
 * Files pages use. A Presentation is composition around Files; it is not a
 * second media system, and it does not get to decide for itself what may be
 * shown inline.
 */

export default function PresentationView({
  presentation,
  /**
   * Where `Previous versions` point. Absent for the staff preview, which has
   * no client-facing address to send anybody to.
   */
  revisionHref,
  /** Shown above the title. The staff preview says it is a draft here. */
  notice,
}: {
  presentation: ClientPresentation;
  revisionHref?: (revision: number) => string;
  notice?: string;
}) {
  const { items, revisions } = presentation;
  const hasHistory = revisionHref !== undefined && revisions.length > 1;

  return (
    <article className={styles.presentation}>
      {notice ? (
        <p className={styles.presentationNotice} role="status">
          {notice}
        </p>
      ) : null}

      <h1 className={styles.display}>{presentation.title}</h1>

      {presentation.intro ? <p className={styles.lede}>{presentation.intro}</p> : null}

      {/* Quiet by design: a client sent one thing is not shown a changelog. The
          revision number appears only once there is more than one, because
          "Revision 1" is a fact about our software rather than about the work. */}
      {presentation.publishedAt ? (
        <p className={styles.presentationMeta}>
          <Moment iso={presentation.publishedAt} />
          {revisions.length > 1 && presentation.revision !== null
            ? ` · Version ${presentation.revision}`
            : ""}
        </p>
      ) : null}

      {items.length === 0 ? (
        <p className={styles.empty}>There is nothing in this presentation yet.</p>
      ) : (
        <div className={styles.presentationFlow}>
          {items.map((item) =>
            item.kind === "note" ? (
              <section key={item.position} className={styles.presentationNote}>
                {item.caption ? <h2 className={styles.presentationHeading}>{item.caption}</h2> : null}
                {/* Whitespace is preserved rather than parsed. A paragraph break
                    a member of staff typed should read as one, and nothing a
                    note contains is ever treated as markup. */}
                <p className={styles.presentationBody}>{item.body}</p>
              </section>
            ) : (
              <section key={item.position} className={styles.presentationPiece}>
                <FileViewer kind={item.file.viewer} source={item.file.sourcePath} name={item.file.name} />

                <div className={styles.presentationCaption}>
                  {item.caption ? <p className={styles.presentationCaptionText}>{item.caption}</p> : null}
                  <p className={styles.presentationFile}>
                    {/* The original, always, for every file without exception —
                        the one promise Stage A makes on every surface. */}
                    <a className={styles.fileAction} href={item.file.downloadPath}>
                      Download {item.file.name}
                    </a>
                    <span className={styles.fileMeta}>
                      {item.file.kind} · {item.file.size}
                    </span>
                  </p>
                </div>
              </section>
            ),
          )}
        </div>
      )}

      {hasHistory ? (
        <section className={styles.presentationHistory}>
          <h2 className={styles.sectionTitle}>Previous versions</h2>
          <ul className={styles.rooms}>
            {revisions
              .filter((entry) => !entry.current)
              .map((entry) => (
                <li key={entry.number} className={styles.room}>
                  <Link className={styles.fileLink} href={revisionHref(entry.number)}>
                    Version {entry.number}
                  </Link>
                  <span className={styles.roomMeta}>
                    <Moment iso={entry.publishedAt} />
                  </span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
