/**
 * How Yiddi Weller writes dates and times — **both worlds, one place**, so two
 * screens cannot disagree about what a moment looks like.
 *
 * **New York, on a 12-hour clock, for everybody.** Yiddi Weller is a New York
 * studio; every user-facing instant is presented in `America/New_York` with
 * AM and PM — *24 Sep 2026 · 12:05 AM* — whoever is reading and wherever the
 * code runs. The zone is the IANA name, never an offset or an abbreviation, so
 * daylight saving moves with the calendar rather than with a constant somebody
 * has to remember to change.
 *
 * **Deterministic by construction.** Every function here names its zone
 * explicitly and never falls back to the runtime's: the Railway server (UTC),
 * a developer's laptop and a client's browser all produce the same characters
 * for the same instant, so the server's HTML and the browser's hydration agree
 * and there is nothing to swap after load.
 *
 * **Display only.** Timestamps are stored as `timestamptz` in UTC and stay
 * that way; nothing here reads or writes the database.
 *
 * The parts are assembled by hand from `formatToParts` rather than trusting a
 * locale's whole pattern: `en-GB` writes *Sept*, `en-US` puts the month first
 * and adds commas, and neither is the house style. The pieces — a short month,
 * a numeric hour with no leading zero, two-digit minutes, `AM`/`PM` — are the
 * same in every engine.
 */

/** The studio's zone. The only one any user-facing date or time is shown in. */
export const DISPLAY_ZONE = "America/New_York";

/**
 * - `exact` — *24 Sep 2026 · 12:05 AM*, for things that happened.
 * - `day` — *24 Sep 2026*, where the hour does not matter.
 * - `time` — *12:05 AM*, beside a date already said.
 */
export type MomentStyle = "exact" | "day" | "time";

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_ZONE,
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function pieces(value: Date): Record<"year" | "month" | "day" | "hour" | "minute" | "dayPeriod", string> {
  const parts = PARTS.formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    dayPeriod: part("dayPeriod").toUpperCase(),
  };
}

/** An instant, as it reads in New York. Empty for anything that is not one. */
export function formatMoment(iso: string, style: MomentStyle = "exact"): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";

  const { year, month, day, hour, minute, dayPeriod } = pieces(value);
  const date = `${day} ${month} ${year}`;
  const time = `${hour}:${minute} ${dayPeriod}`;

  if (style === "day") return date;
  if (style === "time") return time;
  return `${date} · ${time}`;
}

/**
 * The New York wall clock, in the only shape `datetime-local` accepts:
 * `YYYY-MM-DDTHH:mm`, 24-hour, with no zone written on it. The field shows it
 * in the reader's own browser convention; this is only what it is filled with.
 */
export function momentInputValue(iso: string, timeZone: string = DISPLAY_ZONE): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(value);

  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  // hourCycle h23 still yields "24" for midnight in some engines.
  const hour = part("hour") === "24" ? "00" : part("hour");
  return `${part("year")}-${part("month")}-${part("day")}T${hour}:${part("minute")}`;
}

const DAY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
});

/**
 * A date with no clock on it: `2026-09-01` → `1 Sep 2026`.
 *
 * `starts_on` and `target_on` are `date` columns: they name a day rather than
 * an instant, so there is no zone to resolve and it reads the same in New York
 * as anywhere. Written in the same house style as `formatMoment`'s `day`.
 */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const parts = DAY_PARTS.formatToParts(new Date(Date.UTC(year, month - 1, day)));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("day")} ${part("month")} ${part("year")}`;
}
