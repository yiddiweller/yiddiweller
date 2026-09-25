import assert from "node:assert/strict";
import { test } from "node:test";

import { isCurrent, navFor, STUDIO_NAV } from "../lib/studio-nav.ts";
import { DISPLAY_ZONE, formatDate, formatMoment, momentInputValue } from "../lib/studio-format.ts";

/**
 * The two pure pieces of the Studio shell. Neither needs a browser, and both
 * are the sort of thing that breaks silently: navigation that marks the wrong
 * item, or two screens disagreeing about what a date looks like.
 */

test("navigation lists only what exists", () => {
  const hrefs = STUDIO_NAV.flatMap((group) => group.items.map((item) => item.href));
  assert.deepEqual(hrefs, [
    "/studio",
    "/studio/clients",
    "/studio/contacts",
    "/studio/leads",
    "/studio/projects",
    "/studio/workrooms",
    "/studio/search",
    "/studio/team",
    "/studio/audit",
    "/studio/settings",
  ]);
  assert.equal(new Set(hrefs).size, hrefs.length, "no duplicate destinations");

  // Nothing unbuilt may appear. A greyed-out module is dead navigation.
  const labels = STUDIO_NAV.flatMap((g) => g.items.map((i) => i.label.toLowerCase()));
  for (const unbuilt of ["invoices", "files", "reports", "inbox", "payments", "presentations"]) {
    assert.ok(!labels.includes(unbuilt), `${unbuilt} is not built and must not be listed`);
  }
});

test("a Member is not shown a link that would answer not found", () => {
  const member = navFor("member").flatMap((group) => group.items.map((item) => item.href));
  assert.ok(!member.includes("/studio/audit"), "Audit is Owner-only");

  const owner = navFor("owner").flatMap((group) => group.items.map((item) => item.href));
  assert.ok(owner.includes("/studio/audit"));

  // Everything else is the same list: the filter hides, it does not reorder.
  assert.deepEqual(
    owner.filter((href) => href !== "/studio/audit"),
    member,
  );
});

test("Home is current only at Home, and sections claim their own subtree", () => {
  assert.equal(isCurrent("/studio", "/studio"), true);
  assert.equal(isCurrent("/studio", "/studio/team"), false, "Home must not light up everywhere");

  assert.equal(isCurrent("/studio/team", "/studio/team"), true);
  assert.equal(isCurrent("/studio/team", "/studio/team/somebody"), true, "a future detail page");
  assert.equal(isCurrent("/studio/team", "/studio/settings"), false);

  // A record page keeps its section lit.
  assert.equal(isCurrent("/studio/clients", "/studio/clients/0192-..."), true);
  assert.equal(isCurrent("/studio/clients", "/studio/contacts"), false);
});

// ---------------------------------------------------------------- moments

const EVENING_IN_UTC = new Date(Date.UTC(2026, 8, 4, 22, 20)).toISOString();

test("a moment is written in New York, on a 12-hour clock, whatever zone the code runs in", () => {
  // 22:20 UTC on 4 September is 6:20 PM in New York (EDT).
  assert.equal(formatMoment(EVENING_IN_UTC, "exact"), "September 4, 2026 · 6:20 PM");
  assert.equal(formatMoment(EVENING_IN_UTC, "day"), "September 4, 2026");
  assert.equal(formatMoment(EVENING_IN_UTC, "time"), "6:20 PM");
  assert.equal(DISPLAY_ZONE, "America/New_York");
});

test("a date can belong to a different day in New York than in UTC", () => {
  // 02:30 UTC on 5 September is still the evening of the 4th in New York.
  const late = new Date(Date.UTC(2026, 8, 5, 2, 30)).toISOString();
  assert.equal(formatMoment(late, "day"), "September 4, 2026");
  assert.equal(formatMoment(late, "exact"), "September 4, 2026 · 10:30 PM");
});

test("a value that is not a date renders as nothing rather than as Invalid Date", () => {
  assert.equal(formatMoment("not-a-date", "exact"), "");
  assert.equal(formatMoment("", "day"), "");
});

// ------------------------------------------------------- dates without a clock

test("a date column names a day, and says so the same way everywhere", () => {
  assert.equal(formatDate("2026-09-01"), "September 1, 2026");
  assert.equal(formatDate("2026-09-01", "compactDay"), "Sep 1, 2026");
  assert.equal(formatDate("2026-12-31"), "December 31, 2026");
  // Nothing set is nothing shown, not "Invalid Date" and not today.
  assert.equal(formatDate(null), "—");
  assert.equal(formatDate(""), "—");
  assert.equal(formatDate("not a date"), "not a date");
});

test("a datetime-local field is prefilled with the New York wall clock", () => {
  // The same instant, written as the wall clock the rest of the product shows.
  assert.equal(momentInputValue(EVENING_IN_UTC), "2026-09-04T18:20");
  assert.equal(momentInputValue(EVENING_IN_UTC, "UTC"), "2026-09-04T22:20");

  // Midnight is 00, never 24 — a value the input would refuse.
  const midnight = new Date(Date.UTC(2026, 8, 5, 4, 0)).toISOString();
  assert.equal(momentInputValue(midnight), "2026-09-05T00:00");

  assert.equal(momentInputValue("not a date"), "");
});
