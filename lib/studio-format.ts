/**
 * How Studio writes dates. One place, so two screens cannot disagree about
 * what "recently" looks like.
 *
 * Fixed to en-GB rather than the visitor's locale: Studio is one company's
 * internal software, and a date that changes shape depending on who is looking
 * at it makes two people describing the same record disagree.
 */

const DAY_MONTH_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const DAY_MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** "4 Sep, 14:20". For things that happened, where the hour matters. */
export function whenExact(date: Date): string {
  return DAY_MONTH_TIME.format(date);
}

/** "4 Sep 2026". For dates, where it does not. */
export function whenDay(date: Date): string {
  return DAY_MONTH_YEAR.format(date);
}
