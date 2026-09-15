/**
 * How Studio writes dates and times. One place, so two screens cannot disagree
 * about what a moment looks like.
 *
 * **The zone is always explicit.** These functions take one and never fall back
 * to "whatever zone this code happens to be running in" — on Railway that is
 * UTC, which would quietly show every time an hour or two wrong to the person
 * reading it. The server renders UTC and says so; the browser re-renders in the
 * viewer's own zone. `components/studio/Moment.tsx` is the component that does
 * that, and every Studio timestamp goes through it.
 *
 * Locale is fixed to en-GB rather than the viewer's: Studio is one company's
 * internal software, and a date that changes shape depending on who is looking
 * makes two people describing the same record disagree. The zone is the part
 * that has to be personal; the format is not.
 */

export type MomentStyle = "exact" | "day";

/** The zone the server renders in, and the only zone Studio ever labels. */
export const SERVER_ZONE = "UTC";

const OPTIONS: Record<MomentStyle, Intl.DateTimeFormatOptions> = {
  // "4 Sept, 14:20" — for things that happened, where the hour matters.
  exact: { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false },
  // "4 Sept 2026" — for dates, where it does not.
  day: { day: "numeric", month: "short", year: "numeric" },
};

/**
 * Formats an instant in a named zone. Pass `undefined` for the runtime's own
 * zone, which is only ever correct in the browser.
 */
export function formatMoment(iso: string, style: MomentStyle, timeZone?: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", { ...OPTIONS[style], timeZone }).format(value);
}

/**
 * What the server sends: the same instant in UTC, labelled, so it is never
 * silently wrong for the person reading it. The browser replaces it with their
 * own zone; if scripting never runs, this is what stays on screen, and it is
 * true.
 */
export function formatMomentUtc(iso: string, style: MomentStyle): string {
  const text = formatMoment(iso, style, SERVER_ZONE);
  return text && style === "exact" ? `${text} ${SERVER_ZONE}` : text;
}
