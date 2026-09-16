import Link from "next/link";
import { notFound } from "next/navigation";

import Moment from "@/components/studio/Moment";
import { requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { listActivity } from "@/lib/db/activity";
import { projectDatesFor } from "@/lib/db/projects";
import { findWorkroom, workroomPeople } from "@/lib/db/workrooms";
import { toClientActivity, toClientPeople, toClientWorkroomView } from "@/lib/workrooms/view";
import { formatDate } from "@/lib/studio-format";
import studio from "@/app/studio/studio.module.css";
import styles from "@/app/workrooms/workroom.module.css";

export const metadata = { title: "Preview" };

/**
 * What the client sees, seen from Studio.
 *
 * Rendered through the same `toClientWorkroomView` projection as the real page,
 * so the preview cannot drift from the thing it is previewing — if a field is
 * missing here it is missing there.
 *
 * It is a staff-authorized Studio route. It issues no client session, is not a
 * URL a client could discover, and there is no "sign in as this client"
 * anywhere in the product. Staff authority is staff authority; it is not a way
 * to become somebody else.
 */
export default async function WorkroomPreview({ params }: { params: Promise<{ id: string }> }) {
  await requireStaff();
  const { id } = await params;
  if (!isId(id)) notFound();

  const room = await findWorkroom(id);
  if (!room) notFound();

  const [people, activity, dates] = await Promise.all([
    workroomPeople(room.id),
    listActivity(room.id),
    projectDatesFor(room.projectId),
  ]);

  const view = toClientWorkroomView(room, dates);
  const timeline = toClientActivity(activity);

  return (
    <>
      <Link className={studio.back} href={`/studio/workrooms/${room.id}`}>
        ← {room.title}
      </Link>

      <div className={studio.notice}>
        <p className={studio.noticeTitle}>This is the client&rsquo;s view.</p>
        <p>
          The same projection the real page uses, so nothing here is a mock-up. Nobody outside the
          studio can reach this address.
        </p>
      </div>

      <div className={`${styles.tokens} ${studio.section}`}>
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
      </div>
    </>
  );
}
