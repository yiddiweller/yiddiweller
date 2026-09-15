"use client";

import { useEffect, useRef, useState } from "react";

import StudioMark from "@/components/studio/StudioMark";
import StudioNav from "@/components/studio/StudioNav";
import styles from "@/app/studio/studio.module.css";

/**
 * Navigation on small screens. Not the desktop rail squeezed: a drawer that
 * belongs to the phone, opened from the top bar and closed by choosing
 * somewhere to go.
 *
 * It is a native <dialog> opened with showModal(), so the focus trap, the
 * Escape key, the inert background and the return of focus afterwards are the
 * platform's job rather than a hand-rolled imitation of them.
 */
export default function StudioDrawer({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.menuButton}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={styles.menuGlyph} aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        Menu
      </button>

      <dialog
        ref={ref}
        className={styles.drawer}
        aria-label="Studio navigation"
        onClose={() => setOpen(false)}
        onClick={(event) => {
          // A click on the dialog element itself is a click on the backdrop:
          // the inner element covers everything else.
          if (event.target === ref.current) setOpen(false);
        }}
      >
        <div className={styles.drawerInner}>
          <div className={styles.drawerHead}>
            <StudioMark />
            <button type="button" className={styles.buttonQuiet} onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          <div className={styles.drawerBody}>
            <StudioNav onNavigate={() => setOpen(false)} />
          </div>
          {children}
        </div>
      </dialog>
    </>
  );
}
