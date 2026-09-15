"use client";

import { useState, useSyncExternalStore } from "react";

import { SERVER_ZONE, momentInputValue } from "@/lib/studio-format";
import styles from "@/app/studio/studio.module.css";

/**
 * A `datetime-local` field prefilled in the zone of whoever is reading it.
 *
 * The same arrangement as `<Moment>`, and for the same reason: the server has
 * no idea where the reader is, so it renders UTC and the browser re-renders the
 * reader's own zone. Doing it any other way means the digits somebody sees are
 * one zone and the digits the server reads back are another, which is how a
 * follow-up quietly moves by five hours when it is edited.
 *
 * Once the field is typed in, what was typed wins — the suggestion is only a
 * starting point.
 */

// The value never changes after mount, so there is nothing to subscribe to.
const subscribe = () => () => {};

export default function MomentInput({
  id,
  name,
  iso,
}: {
  id: string;
  name: string;
  iso: string | null;
}) {
  const suggested = useSyncExternalStore(
    subscribe,
    () => (iso ? momentInputValue(iso) : ""),
    () => (iso ? momentInputValue(iso, SERVER_ZONE) : ""),
  );
  const [edited, setEdited] = useState<string | null>(null);

  return (
    <input
      id={id}
      name={name}
      type="datetime-local"
      className={styles.input}
      value={edited ?? suggested}
      onChange={(event) => setEdited(event.target.value)}
    />
  );
}
