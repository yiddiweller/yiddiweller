/**
 * How Yiddi Weller writes dates and times — **both worlds, one place**, so two
 * screens cannot disagree about what a moment looks like.
 *
 * **New York, on a 12-hour clock, month first, for everybody.** Yiddi Weller
 * is a New York studio; every user-facing instant is presented in
 * `America/New_York`, with AM and PM and the U.S. date order — *September 24,
 * 2026 · 12:05 AM* — whoever is reading and wherever the code runs. The zone is the IANA name, never an offset or an abbreviation, so
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
 * locale's whole pattern, which varies between engines in its separators and
 * in whether it puts *at* between the date and the time. The pieces — the
 * month's name, the day, the year, a numeric hour with no leading zero,
 * two-digit minutes, `AM`/`PM` — are the same everywhere.
 */

/** The studio's zone. The only one any user-facing date or time is shown in. */
export const DISPLAY_ZONE = "America/New_York";

/**
 * - `exact` — *September 24, 2026 · 12:05 AM*, for things that happened.
 * - `day` — *September 24, 2026*, where the hour does not matter.
 * - `time` — *12:05 AM*, beside a date already said.
 * - `compact` — *Sep 24, 2026 · 12:05 AM*, and `compactDay` — *Sep 24, 2026* —
 *   **only** for dense metadata: Studio's list rows, where the date sits in an
 *   uppercase, unwrapped column beside everything else on the line. Everywhere
 *   a person is reading rather than scanning, the month is written out.
 */
export type MomentStyle = "exact" | "day" | "time" | "compact" | "compactDay";

const partsIn = (month: "long" | "short") =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: DISPLAY_ZONE,
    year: "numeric",
    month,
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

const LONG = partsIn("long");
const SHORT = partsIn("short");

function pieces(
  value: Date,
  month: "long" | "short",
): Record<"year" | "month" | "day" | "hour" | "minute" | "dayPeriod", string> {
  const parts = (month === "long" ? LONG : SHORT).formatToParts(value);
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

  const compact = style === "compact" || style === "compactDay";
  const { year, month, day, hour, minute, dayPeriod } = pieces(value, compact ? "short" : "long");
  const date = `${month} ${day}, ${year}`;
  const time = `${hour}:${minute} ${dayPeriod}`;

  if (style === "day" || style === "compactDay") return date;
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

const dayPartsIn = (month: "long" | "short") =>
  new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month, day: "numeric" });

const DAY_LONG = dayPartsIn("long");
const DAY_SHORT = dayPartsIn("short");

/**
 * A date with no clock on it: `2026-09-01` → `September 1, 2026`, or
 * `Sep 1, 2026` in a dense row.
 *
 * `starts_on` and `target_on` are `date` columns: they name a day rather than
 * an instant, so there is no zone to resolve and it reads the same in New York
 * as anywhere. Written in the same house style as `formatMoment`'s `day`.
 */
export function formatDate(value: string | null | undefined, style: "day" | "compactDay" = "day"): string {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  const parts = (style === "compactDay" ? DAY_SHORT : DAY_LONG).formatToParts(new Date(Date.UTC(year, month - 1, day)));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("month")} ${part("day")}, ${part("year")}`;
}

/* ------------------------------------------------ New York wall-clock input */

/**
 * What a `datetime-local` value can turn out to be, read as New York time.
 *
 * - `malformed`: not the shape the field sends, or not a real calendar date
 *   and time — 31 February, month 13, 25:00. Never normalised into another.
 * - `nonexistent`: a time in the hour New York skips when the clocks go
 *   forward. Not moved to the next real time.
 * - `ambiguous`: a time in the hour New York lives twice when the clocks go
 *   back. Not quietly given the first or the second.
 */
export type WallTimeRefusal = "malformed" | "nonexistent" | "ambiguous";

export type WallTime = { ok: true; value: Date | null } | { ok: false; reason: WallTimeRefusal };

// The field's own shape: `YYYY-MM-DDTHH:mm`, with whole seconds allowed
// because the HTML standard allows them and a browser may send them.
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

const WALL = new Intl.DateTimeFormat("en-US", {
  timeZone: DISPLAY_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** An instant's New York wall clock, written as if it were UTC — for comparing. */
function wallOf(instant: number): number {
  const parts = WALL.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? Number.NaN);
  const hour = part("hour") === 24 ? 0 : part("hour");
  return Date.UTC(part("year"), part("month") - 1, part("day"), hour, part("minute"), part("second"));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A `datetime-local` value, as **this wall-clock time in New York** — the
 * instant to store, or why there is none.
 *
 * The field carries no zone, so the zone is the product's, stated here:
 * `America/New_York`, whatever zone the server, the laptop or the browser is
 * in. `new Date(raw)` would read it in the *process's* zone instead — UTC on
 * Railway — which is exactly how a follow-up entered in New York used to be
 * stored hours off.
 *
 * No offset is written down. The offsets New York actually uses on either side
 * of the typed time come from the zone's own rules; each gives one candidate
 * instant, and a candidate counts only if it reads back as exactly the typed
 * wall clock. One match is the answer. None means the clocks skipped that
 * time; two means they lived it twice. An empty field is no time at all.
 */
export function readWallTime(raw: string): WallTime {
  if (raw.trim() === "") return { ok: true, value: null };

  const match = LOCAL.exec(raw);
  if (!match) return { ok: false, reason: "malformed" };
  const [year, month, day, hour, minute, second] = match.slice(1).map((piece) => Number(piece ?? 0)) as [
    number, number, number, number, number, number,
  ];

  // A real calendar date and a real clock time, checked rather than trusted:
  // `Date.UTC` would roll 31 February into March and 25:00 into tomorrow.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    return { ok: false, reason: "malformed" };
  }

  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsets = new Set([wall - DAY_MS, wall, wall + DAY_MS].map((probe) => wallOf(probe) - probe));
  const instants = [...new Set([...offsets].map((offset) => wall - offset))].filter(
    (instant) => wallOf(instant) === wall,
  );

  if (instants.length === 0) return { ok: false, reason: "nonexistent" };
  if (instants.length > 1) return { ok: false, reason: "ambiguous" };
  return { ok: true, value: new Date(instants[0]!) };
}
