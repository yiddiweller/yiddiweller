"use client";

import { useState } from "react";

import { momentInputValue } from "@/lib/studio-format";
import styles from "@/app/studio/studio.module.css";

/**
 * A `datetime-local` field prefilled with the New York wall clock — the zone
 * every other date and time in the product is shown in — the same on the
 * server and in the browser.
 *
 * Once the field is typed in, what was typed wins — the suggestion is only a
 * starting point.
 */
export default function MomentInput({
  id,
  name,
  iso,
}: {
  id: string;
  name: string;
  iso: string | null;
}) {
  const suggested = iso ? momentInputValue(iso) : "";
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
