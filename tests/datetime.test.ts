import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { DISPLAY_ZONE, formatMoment } from "../lib/studio-format.ts";

/**
 * How Yiddi Weller writes an instant: in New York, on a 12-hour clock.
 *
 * *September 24, 2026 · 12:05 AM*. Stored timestamps are UTC and stay UTC; this is
 * presentation only, and it is the same characters on a server in UTC, a
 * laptop in Tokyo and a browser anywhere.
 */

const at = (iso: string) => formatMoment(iso, "exact");

test("the studio's zone is New York, by its IANA name — never an offset or an abbreviation", () => {
  assert.equal(DISPLAY_ZONE, "America/New_York");
  const source = readFileSync("lib/studio-format.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(source, /\b(EST|EDT|UTC-5|UTC-4|GMT-5|GMT-4)\b|-0[45]:00/);
});

test("around the clock: midnight, morning, noon, afternoon and the last minute", () => {
  // Summer, so New York is UTC−4: each instant below is the New York clock + 4h.
  for (const [iso, expected] of [
    ["2026-09-24T04:05:00Z", "September 24, 2026 · 12:05 AM"],
    ["2026-09-24T13:07:00Z", "September 24, 2026 · 9:07 AM"],
    ["2026-09-24T16:00:00Z", "September 24, 2026 · 12:00 PM"],
    ["2026-09-24T17:30:00Z", "September 24, 2026 · 1:30 PM"],
    ["2026-09-25T03:59:00Z", "September 24, 2026 · 11:59 PM"],
  ]) {
    assert.equal(at(iso), expected, iso);
  }
});

test("the styles: month first, the month written out, and short only where it is dense", () => {
  const i = "2026-09-25T03:26:00Z"; // 11:26 PM on September 24 in New York
  assert.equal(formatMoment(i, "exact"), "September 24, 2026 · 11:26 PM");
  assert.equal(formatMoment(i, "day"), "September 24, 2026");
  assert.equal(formatMoment(i, "time"), "11:26 PM");
  assert.equal(formatMoment(i, "compact"), "Sep 24, 2026 · 11:26 PM");
  assert.equal(formatMoment(i, "compactDay"), "Sep 24, 2026");
  assert.equal(formatMoment(i), formatMoment(i, "exact"), "the default is the full form");

  // Every month, written out and abbreviated — September as Sep, never Sept.
  for (const [month, long, short] of [
    ["01", "January", "Jan"], ["02", "February", "Feb"], ["03", "March", "Mar"], ["04", "April", "Apr"],
    ["05", "May", "May"], ["06", "June", "Jun"], ["07", "July", "Jul"], ["08", "August", "Aug"],
    ["09", "September", "Sep"], ["10", "October", "Oct"], ["11", "November", "Nov"], ["12", "December", "Dec"],
  ]) {
    assert.equal(formatMoment(`2026-${month}-15T17:00:00Z`, "day"), `${long} 15, 2026`);
    assert.equal(formatMoment(`2026-${month}-15T17:00:00Z`, "compactDay"), `${short} 15, 2026`);
  }

  // Never day first, in any style.
  for (const style of ["exact", "day", "compact", "compactDay"] as const) {
    assert.doesNotMatch(formatMoment(i, style), /^\d|24 Sep|24 September|2026-09-24/, style);
  }
});

test("winter is Eastern Standard Time and summer is Eastern Daylight Time", () => {
  // The same UTC clock reading lands an hour apart in New York.
  assert.equal(at("2026-01-15T17:05:00Z"), "January 15, 2026 · 12:05 PM", "January: UTC−5");
  assert.equal(at("2026-07-15T17:05:00Z"), "July 15, 2026 · 1:05 PM", "July: UTC−4");
});

test("across both 2026 transitions the clock does what New York's does", () => {
  // Spring forward, 8 March: 1:59 AM EST is followed by 3:00 AM EDT.
  assert.equal(at("2026-03-08T06:59:00Z"), "March 8, 2026 · 1:59 AM");
  assert.equal(at("2026-03-08T07:00:00Z"), "March 8, 2026 · 3:00 AM");

  // Fall back, 1 November: 1:30 AM happens twice, an hour apart, and each
  // instant always gives the same answer.
  assert.equal(at("2026-11-01T05:30:00Z"), "November 1, 2026 · 1:30 AM", "first 1:30, EDT");
  assert.equal(at("2026-11-01T06:30:00Z"), "November 1, 2026 · 1:30 AM", "second 1:30, EST");
  assert.equal(at("2026-11-01T07:00:00Z"), "November 1, 2026 · 2:00 AM");
});

test("a date belongs to New York's day, not UTC's", () => {
  assert.equal(formatMoment("2026-09-25T02:30:00Z", "day"), "September 24, 2026");
  assert.equal(formatMoment("2026-12-31T23:30:00Z", "exact"), "December 31, 2026 · 6:30 PM");
  assert.equal(formatMoment("2027-01-01T05:30:00Z", "exact"), "January 1, 2027 · 12:30 AM");
});

test("the same characters whatever zone the process runs in", () => {
  const formatter = pathToFileURL(join(process.cwd(), "lib/studio-format.ts")).href;
  const instants = ["2026-09-24T04:05:00Z", "2026-03-08T07:00:00Z", "2026-11-01T06:30:00Z", "2026-01-15T17:05:00Z"];
  const script = `const { formatMoment, momentInputValue } = await import(${JSON.stringify(formatter)});
console.log(JSON.stringify(${JSON.stringify(instants)}.map((iso) => [formatMoment(iso), formatMoment(iso, "day"), formatMoment(iso, "compact"), momentInputValue(iso)])));`;

  const results = ["UTC", "Asia/Tokyo", "America/Los_Angeles", "Europe/London", "Pacific/Kiritimati"].map((zone) =>
    execFileSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], {
      env: { ...process.env, TZ: zone },
      encoding: "utf8",
    }).trim(),
  );

  for (const result of results) assert.equal(result, results[0], "a process zone leaked into the output");
  assert.deepEqual(JSON.parse(results[0]!)[0], ["September 24, 2026 · 12:05 AM", "September 24, 2026", "Sep 24, 2026 · 12:05 AM", "2026-09-24T00:05"]);
});

/* -------------------------------------------------- one formatter, everywhere */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("nothing formats a date or time for a person except the one formatter", () => {
  for (const file of [...sources("app"), ...sources("components"), ...sources("lib")]) {
    if (file === join("lib", "studio-format.ts")) continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      text,
      /Intl\.DateTimeFormat|toLocale(Date|Time)?String|getHours\(|hour12/,
      `${file} formats a date or time itself`,
    );
  }

  // And the one component that shows an instant renders it once, finally —
  // no server text replaced by a browser one.
  const moment = readFileSync("components/studio/Moment.tsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(moment, /useSyncExternalStore|use client|UTC/);
});
