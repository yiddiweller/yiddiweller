import Link from "next/link";

import Moment from "@/components/studio/Moment";
import { requireViewer } from "@/lib/client-auth/guard";
import { workroomsForViewer } from "@/lib/db/workrooms";
import { label } from "@/lib/business";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * Everything this person may open, and nothing else.
 *
 * Membership is part of the query rather than a filter applied afterwards, so
 * there is no list to forget to narrow: a Workroom they are not in is never
 * read at all.
 */
export default async function WorkroomsIndex() {
  const viewer = await requireViewer();
  const rooms = await workroomsForViewer(viewer.contactId);

  if (rooms.length === 1) {
    // One project is the ordinary case. An index of one is a page nobody needs.
    const only = rooms[0]!;
    return (
      <>
        <p className={styles.eyebrow}>{only.clientName}</p>
        <h1 className={styles.display}>{only.title}</h1>
        <p className={styles.lede}>
          Your private space for this work.{" "}
          <Link className={styles.quiet} href={`/workrooms/${only.publicId}`}>
            Open it
          </Link>
          .
        </p>
      </>
    );
  }

  return (
    <>
      <p className={styles.eyebrow}>Yiddi Weller</p>
      <h1 className={styles.display}>Your workrooms</h1>

      <div className={styles.sections}>
        <section className={styles.section}>
          {rooms.length === 0 ? (
            <p className={styles.empty}>
              There is nothing open to you at the moment. If you were expecting a project here,
              reply to the last message you had from us and we will sort it out.
            </p>
          ) : (
            <ul className={styles.rooms}>
              {rooms.map((room) => (
                <li key={room.publicId}>
                  <Link className={styles.room} href={`/workrooms/${room.publicId}`}>
                    <span className={styles.roomTitle}>{room.title}</span>
                    <span className={styles.roomMeta}>
                      {room.clientName} · {label(room.projectStatus)} · updated{" "}
                      <Moment iso={room.updatedAt.toISOString()} style="day" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
