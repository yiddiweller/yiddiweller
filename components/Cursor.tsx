"use client";

import { useEffect, useRef } from "react";

import styles from "./Cursor.module.css";

const INTERACTIVE = 'a, button, input, textarea, select, summary, [role="button"]';

/**
 * A small white dot that replaces the pointer on devices that actually have
 * one. Position is written straight to the node inside a rAF, so the dot
 * tracks the pointer exactly — no easing, no trail, no re-renders.
 */
export default function Cursor() {
  const dotRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dotRef.current;
    if (!el) return;

    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    const root = document.documentElement;

    let attached = false;
    let frame = 0;
    let queued = false;
    let x = 0;
    let y = 0;

    const paint = () => {
      queued = false;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      x = event.clientX;
      y = event.clientY;
      el.dataset.visible = "true";
      if (!queued) {
        queued = true;
        frame = requestAnimationFrame(paint);
      }
    };

    const onOver = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      el.dataset.interactive = target.closest(INTERACTIVE) ? "true" : "false";
    };

    const hide = () => {
      el.dataset.visible = "false";
    };

    const attach = () => {
      if (attached) return;
      attached = true;
      root.dataset.cursor = "on";
      document.addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerover", onOver, { passive: true });
      document.addEventListener("pointerleave", hide);
      window.addEventListener("blur", hide);
    };

    const detach = () => {
      if (!attached) return;
      attached = false;
      delete root.dataset.cursor;
      hide();
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerleave", hide);
      window.removeEventListener("blur", hide);
    };

    // Re-evaluated live, so plugging in or removing a mouse is handled.
    const sync = () => (fine.matches ? attach() : detach());

    sync();
    fine.addEventListener("change", sync);

    return () => {
      fine.removeEventListener("change", sync);
      detach();
    };
  }, []);

  return (
    <div ref={dotRef} className={styles.cursor} data-visible="false" aria-hidden="true">
      <span className={styles.dot} />
    </div>
  );
}
