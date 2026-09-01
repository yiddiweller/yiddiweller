"use client";

import { useEffect } from "react";

/**
 * Fades the fixed header out over the first stretch of scroll, so it never
 * collides with the content rising underneath it. The distance scales with
 * the viewport, so the header is gone at the same point on any screen.
 *
 * Writes a CSS variable rather than owning the markup, which keeps the
 * header itself a server component.
 */
export default function HeaderFade() {
  useEffect(() => {
    const root = document.documentElement;
    let frame = 0;
    let queued = false;

    const apply = () => {
      queued = false;
      const distance = Math.max(96, window.innerHeight * 0.25);
      const progress = Math.min(1, Math.max(0, window.scrollY) / distance);
      root.style.setProperty("--header-fade", String(1 - progress));
      // Once invisible it must also leave the tab order, or a keyboard user
      // lands on a link they cannot see.
      root.dataset.header = progress >= 1 ? "hidden" : "shown";
    };

    const onScroll = () => {
      if (queued) return;
      queued = true;
      frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      root.style.removeProperty("--header-fade");
      delete root.dataset.header;
    };
  }, []);

  return null;
}
