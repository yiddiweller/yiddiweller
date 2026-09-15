import assert from "node:assert/strict";
import { test } from "node:test";

// Before the formatters are imported: Intl resolves the zone once, and these
// assertions are about the format, not about where the machine running them
// happens to be. Railway runs UTC, which is what Studio renders in.
process.env.TZ = "UTC";

import { isCurrent, STUDIO_NAV } from "../lib/studio-nav.ts";
import { whenDay, whenExact } from "../lib/studio-format.ts";

/**
 * The two pure pieces of the Studio shell. Neither needs a browser, and both
 * are the sort of thing that breaks silently: navigation that marks the wrong
 * item, or two screens disagreeing about what a date looks like.
 */

test("navigation lists only what exists", () => {
  const hrefs = STUDIO_NAV.flatMap((group) => group.items.map((item) => item.href));
  assert.deepEqual(hrefs, ["/studio", "/studio/team", "/studio/settings"]);
  assert.equal(new Set(hrefs).size, hrefs.length, "no duplicate destinations");

  // Nothing unbuilt may appear. A greyed-out module is dead navigation.
  const labels = STUDIO_NAV.flatMap((g) => g.items.map((i) => i.label.toLowerCase()));
  for (const unbuilt of ["clients", "projects", "invoices", "files", "reports", "inbox"]) {
    assert.ok(!labels.includes(unbuilt), `${unbuilt} is not built and must not be listed`);
  }
});

test("Home is current only at Home, and sections claim their own subtree", () => {
  assert.equal(isCurrent("/studio", "/studio"), true);
  assert.equal(isCurrent("/studio", "/studio/team"), false, "Home must not light up everywhere");

  assert.equal(isCurrent("/studio/team", "/studio/team"), true);
  assert.equal(isCurrent("/studio/team", "/studio/team/somebody"), true, "a future detail page");
  assert.equal(isCurrent("/studio/team", "/studio/settings"), false);
});

test("dates read the same wherever they appear", () => {
  const date = new Date(Date.UTC(2026, 8, 4, 14, 20));
  assert.equal(whenExact(date), "4 Sept, 14:20", "24-hour, because this is working software");
  assert.equal(whenDay(date), "4 Sept 2026");
});
