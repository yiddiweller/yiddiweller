import { formatMoment, type MomentStyle } from "@/lib/studio-format";

/**
 * One instant, as Yiddi Weller writes it: in New York, on a 12-hour clock —
 * *24 Sep 2026 · 12:05 AM* — for a client and for the studio alike.
 *
 * Every user-facing timestamp goes through this, in both worlds. The database
 * keeps UTC and that does not change; this is display, at the edge.
 *
 * **The same characters on the server and in the browser.** The zone is named,
 * never the runtime's, so the HTML the server sends is already final: there is
 * no second render in the reader's own zone and nothing to mismatch on
 * hydration. A reader somewhere else sees the studio's time, which is the
 * product's choice until there is ever a per-person setting.
 *
 * `<time dateTime>` carries the exact instant for anything reading the page
 * mechanically, in a format that depends on no zone at all.
 */
export default function Moment({
  iso,
  style = "exact",
  className,
}: {
  iso: string;
  style?: MomentStyle;
  className?: string;
}) {
  return (
    <time className={className} dateTime={iso}>
      {formatMoment(iso, style)}
    </time>
  );
}
