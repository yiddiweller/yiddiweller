"use client";

import { useSyncExternalStore } from "react";

import { formatMoment, formatMomentUtc, type MomentStyle } from "@/lib/studio-format";

/**
 * One instant, rendered in the zone of whoever is reading it.
 *
 * Every timestamp in Studio goes through this. The database keeps UTC and that
 * does not change; this is a display concern and lives entirely at the edge.
 *
 * `useSyncExternalStore` is how the two sides differ without a hydration
 * mismatch: React takes the server snapshot for the HTML it hydrates, then the
 * client snapshot, and re-renders the difference. An effect that set state
 * would do the same job less honestly and would trip on React's own rules.
 *
 * The server's snapshot is UTC with the zone written out, so the text is never
 * quietly wrong — including when scripting never runs at all, which is the one
 * case the browser cannot fix.
 *
 * `<time dateTime>` carries the exact instant for anything reading the page
 * mechanically, in a format that does not depend on either zone.
 */

// The value never changes after mount, so there is nothing to subscribe to.
const subscribe = () => () => {};

export default function Moment({
  iso,
  style = "exact",
  className,
}: {
  iso: string;
  style?: MomentStyle;
  className?: string;
}) {
  const text = useSyncExternalStore(
    subscribe,
    () => formatMoment(iso, style),
    () => formatMomentUtc(iso, style),
  );

  return (
    <time className={className} dateTime={iso}>
      {text}
    </time>
  );
}
