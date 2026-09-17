import Link from "next/link";

import Moment from "@/components/studio/Moment";
import { type ClientFile } from "@/lib/workrooms/delivery-view";
import { type ClientActivityItem, type ClientWorkroomView } from "@/lib/workrooms/view";
import { formatDate } from "@/lib/studio-format";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * What a client sees when they open their Workroom.
 *
 * **One component, rendered by two routes**: the client's own page and the
 * staff preview. That is not tidiness — it is the only way the preview's
 * promise can be true. It says "the same projection the real page uses, so
 * nothing here is a mock-up", and while the two routes each held their own copy
 * of this markup that sentence was only true until somebody edited one of them.
 *
 * Somebody did. Build 005 added a Files section to the client's page and not to
 * the preview, so a file could be shared, appear in the client's Workroom, and
 * be invisible to the person checking their work. Nothing failed; the preview
 * simply showed an older product. This component exists so that cannot happen
 * again: there is no second copy to forget.
 *
 * It receives data already projected — `ClientWorkroomView`, `ClientFile`,
 * `ClientActivityItem` — and never a database row. The whitelist happens before
 * anything reaches here, so this file cannot leak a field it is not given.
 */

export default function WorkroomOverview({
  view,
  people,
  files,
  timeline,
  otherRooms,
}: {
  view: ClientWorkroomView;
  people: { name: string; role: string | null }[];
  files: ClientFile[];
  timeline: ClientActivityItem[];
  /** How many Workrooms this person can reach. One means no "back" link. */
  otherRooms: number;
}) {
  return (
    <>
      {otherRooms > 1 ? (
        <p className={styles.eyebrow}>
          <Link className={styles.quiet} href="/workrooms">
            ← Your workrooms
          </Link>
        </p>
      ) : null}

      <p className={styles.eyebrow}>{view.clientName}</p>
      <h1 className={styles.display}>{view.title}</h1>
      {view.summary ? <p className={styles.lede}>{view.summary}</p> : null}

      <div className={styles.sections}>
        <section className={styles.section} aria-label="Where the work is">
          <div className={styles.facts}>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Status</span>
              <span className={styles.factValue}>{view.status}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Started</span>
              <span className={styles.factValue}>{formatDate(view.startsOn)}</span>
            </div>
            <div className={styles.fact}>
              <span className={styles.factLabel}>Target</span>
              <span className={styles.factValue}>{formatDate(view.targetOn)}</span>
            </div>
          </div>
        </section>

        {/* The client's way into Files. Present only when there is something to
            open — an empty section inviting somebody to look at nothing is
            worse than no section, and this world stays quiet. The three most
            recent are named here so the link is worth pressing. */}
        {files.length > 0 ? (
          <section className={styles.section}>
            <h2 className={styles.sectionTitle}>Files</h2>
            <ul className={styles.files}>
              {files.slice(0, 3).map((file) => (
                <li key={file.id} className={styles.file}>
                  <a className={styles.fileLink} href={file.downloadPath}>
                    {file.name}
                  </a>
                  <span className={styles.fileMeta}>
                    {file.kind} · {file.size}
                  </span>
                </li>
              ))}
            </ul>
            <p className={styles.more}>
              <Link className={styles.quiet} href={`/workrooms/${view.id}/files`}>
                {files.length === 1 ? "Open files" : `All ${files.length} files`} →
              </Link>
            </p>
          </section>
        ) : null}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Who is here</h2>
          <ul className={styles.people}>
            {people.map((person) => (
              <li key={person.name} className={styles.person}>
                <span className={styles.personName}>{person.name}</span>
                {person.role ? <span className={styles.personRole}>{person.role}</span> : null}
              </li>
            ))}
            <li className={styles.person}>
              <span className={styles.personName}>Yiddi Weller</span>
              <span className={styles.personRole}>Design and build</span>
            </li>
          </ul>
        </section>

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>What has happened</h2>
          {timeline.length === 0 ? (
            <p className={styles.empty}>Nothing yet. This is where changes will appear.</p>
          ) : (
            <ul className={styles.timeline}>
              {timeline.map((event) => (
                <li key={event.id} className={styles.event}>
                  <span className={styles.eventText}>{event.text}</span>
                  <Moment className={styles.eventWhen} iso={event.occurredAt} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
