import Link from "next/link";
import { notFound } from "next/navigation";

import Moment from "@/components/studio/Moment";
import { requireViewer } from "@/lib/client-auth/guard";
import { listActivity } from "@/lib/db/activity";
import { workroomForViewer, workroomPeople, workroomsForViewer } from "@/lib/db/workrooms";
import { projectDatesFor } from "@/lib/db/projects";
import { toClientActivity, toClientPeople, toClientWorkroomView } from "@/lib/workrooms/view";
import { formatDate } from "@/lib/studio-format";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * One Workroom.
 *
 * `requireViewer` runs here, before the first read, and the read itself carries
 * the membership — so a request from somebody who is not a member never
 * fetches the row. A Workroom that exists and one that never did produce the
 * same 404, because "you do not have access to Acme's rebrand" tells a stranger
 * that Acme's rebrand exists.
 *
 * Everything on the page comes through `toClientWorkroomView`. A database row
 * is never spread into this component.
 */
export default async function Workroom({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await requireViewer();
  const { id } = await params;

  const room = await workroomForViewer(viewer.contactId, id);
  if (!room) notFound();

  const [people, activity, dates, others] = await Promise.all([
    workroomPeople(room.id),
    listActivity(room.id),
    projectDatesFor(room.projectId),
    workroomsForViewer(viewer.contactId),
  ]);

  const view = toClientWorkroomView(room, dates);
  const timeline = toClientActivity(activity);

  return (
    <>
      {others.length > 1 ? (
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

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Who is here</h2>
          <ul className={styles.people}>
            {toClientPeople(people).map((person) => (
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
