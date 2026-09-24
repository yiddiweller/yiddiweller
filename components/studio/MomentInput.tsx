"use client";

import { useState } from "react";

import { momentInputValue } from "@/lib/studio-format";
import styles from "@/app/studio/studio.module.css";

/**
 * A `datetime-local` field that means **New York wall-clock time**, both ways:
 * prefilled with the stored instant's New York clock (`momentInputValue`) and
 * read back as New York time by `readWallTime` on the server. The two are the
 * same rule, so saving the form without touching the field stores the same
 * instant — whatever zone the browser or the server is in.
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
