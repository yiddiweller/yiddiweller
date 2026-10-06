"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import styles from "@/app/studio/studio.module.css";

/**
 * A place for one calm sentence after an action succeeded, that outlives the
 * control that caused it.
 *
 * A `RecordAction` keeps its own result, so a refusal is shown beside the
 * button. A success usually needs no words — the page changes. But when the
 * page changing *removes* the button, as asking for feedback does, anything
 * the button was holding goes with it. This sits one level up, at a place the
 * refresh does not replace, and keeps the last sentence it was handed until
 * the person leaves the page.
 *
 * Opt-in: only a `RecordAction` with `announce` writes here.
 */

const Announce = createContext<((message: string) => void) | null>(null);

export function useAnnounce(): ((message: string) => void) | null {
  return useContext(Announce);
}

export default function Announcement({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  return (
    <Announce.Provider value={setMessage}>
      {children}
      <p className={styles.status} role="status">
        {message}
      </p>
    </Announce.Provider>
  );
}
