import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { optionalMoment } from "../lib/business.ts";
import { formatMoment, momentInputValue, readWallTime } from "../lib/studio-format.ts";

/**
 * A `datetime-local` value means **this wall-clock time in New York**.
 *
 * The field carries no zone. `new Date(raw)` reads it in the process's zone —
 * UTC on Railway — which stored a follow-up typed in New York four or five
 * hours early and moved it again on every save. These pin the rule that
 * replaced it: New York's own, whatever zone anything runs in, refusing what
 * is not a real New York time rather than guessing.
 */

const stored = (raw: string) => {
  const read = readWallTime(raw);
  assert.ok(read.ok, `${raw} was refused: ${read.ok ? "" : read.reason}`);
  return read.value?.toISOString() ?? null;
};

/* ------------------------------------------------------------ conversion */

test("winter is New York's standard time and summer its daylight time", () => {
  assert.equal(stored("2026-01-15T14:00"), "2026-01-15T19:00:00.000Z", "January, 2:00 PM");
  assert.equal(stored("2026-07-15T14:00"), "2026-07-15T18:00:00.000Z", "July, 2:00 PM");
});

test("midnight, noon and a typed minute are the instants they name", () => {
  assert.equal(stored("2026-09-24T00:00"), "2026-09-24T04:00:00.000Z");
  assert.equal(stored("2026-09-24T12:00"), "2026-09-24T16:00:00.000Z");
  assert.equal(stored("2026-09-24T14:30"), "2026-09-24T18:30:00.000Z");
  assert.equal(stored("2026-12-31T23:59"), "2027-01-01T04:59:00.000Z");
  assert.equal(stored("2024-02-29T09:00"), "2024-02-29T14:00:00.000Z", "a leap day");
  // Seconds are allowed, because the HTML standard allows the field to send them.
  assert.equal(stored("2026-09-24T14:30:15"), "2026-09-24T18:30:15.000Z");
});

test("an empty field is no follow-up, never Invalid Date", () => {
  assert.deepEqual(readWallTime(""), { ok: true, value: null });
  assert.deepEqual(readWallTime("   "), { ok: true, value: null });
  assert.deepEqual(optionalMoment(null), { ok: true, value: null });
  assert.deepEqual(optionalMoment(undefined), { ok: true, value: null });
  assert.deepEqual(optionalMoment(""), { ok: true, value: null });
});

test("anything that is not a real date and time is refused, never rolled into another", () => {
  for (const raw of [
    "nope",
    "2026-09-24",
    "2026-09-24 14:30",
    "2026-09-24T14:30Z",
    "2026-09-24T14:30-04:00",
    "2026-09-24T14:30:15.5",
    "26-09-24T14:30",
    "2026-13-01T10:00",
    "2026-00-10T10:00",
    "2026-02-31T10:00",
    "2026-02-29T10:00",
    "2026-04-31T10:00",
    "2026-09-00T10:00",
    "2026-09-24T24:00",
    "2026-09-24T25:00",
    "2026-09-24T14:60",
    "2026-09-24T14:30:60",
  ]) {
    assert.deepEqual(readWallTime(raw), { ok: false, reason: "malformed" }, raw);
  }
});

/* ------------------------------------------------------------ daylight saving */

test("a time New York skips is refused, not moved", () => {
  // 8 March 2026: 2:00 AM becomes 3:00 AM.
  for (const raw of ["2026-03-08T02:00", "2026-03-08T02:30", "2026-03-08T02:59"]) {
    assert.deepEqual(readWallTime(raw), { ok: false, reason: "nonexistent" }, raw);
  }
  // Either side of the gap is an ordinary time.
  assert.equal(stored("2026-03-08T01:59"), "2026-03-08T06:59:00.000Z");
  assert.equal(stored("2026-03-08T03:00"), "2026-03-08T07:00:00.000Z");
});

test("a time New York lives twice is refused, not quietly given the first or the second", () => {
  // 1 November 2026: 2:00 AM becomes 1:00 AM, so 1:00–1:59 happens twice.
  for (const raw of ["2026-11-01T01:00", "2026-11-01T01:30", "2026-11-01T01:59"]) {
    assert.deepEqual(readWallTime(raw), { ok: false, reason: "ambiguous" }, raw);
  }
  assert.equal(stored("2026-11-01T00:59"), "2026-11-01T04:59:00.000Z");
  assert.equal(stored("2026-11-01T02:00"), "2026-11-01T07:00:00.000Z");
});

test("a refusal is a sentence a person can act on, with no zone or offset in it", () => {
  const said = (raw: string) => {
    const read = optionalMoment(raw);
    assert.ok(!read.ok);
    return read.message;
  };
  assert.equal(said("2026-03-08T02:30"), "That time does not happen in New York — the clocks go forward then. Choose another time.");
  assert.equal(said("2026-11-01T01:30"), "That time happens twice in New York — the clocks go back then. Choose a different time.");
  assert.equal(said("2026-02-31T10:00"), "That is not a date and time. Choose one from the calendar.");
  for (const raw of ["2026-03-08T02:30", "2026-11-01T01:30", "nope"]) {
    assert.doesNotMatch(said(raw), /UTC|GMT|EST|EDT|offset|America\//);
  }
});

/* ------------------------------------------------------------ round trips */

test("a stored instant, prefilled and saved untouched, is the same instant — winter and summer", () => {
  for (const instant of [
    "2026-01-15T19:00:00.000Z",
    "2026-07-15T18:00:00.000Z",
    "2026-09-24T04:05:00.000Z",
    "2026-03-08T07:00:00.000Z",
    "2026-11-01T07:00:00.000Z",
  ]) {
    const prefill = momentInputValue(instant);
    assert.equal(stored(prefill), instant, `${instant} → ${prefill} drifted`);
    // And again: no drift accumulates across saves.
    assert.equal(stored(momentInputValue(stored(prefill)!)), instant);
  }
});

test("a time typed in the field reads back as exactly what was typed, and says the same thing", () => {
  const instant = stored("2026-09-24T14:30")!;
  assert.equal(formatMoment(instant, "exact"), "24 Sep 2026 · 2:30 PM");
  assert.equal(momentInputValue(instant), "2026-09-24T14:30");
});

/* ------------------------------------------------------------ any zone */

test("the same answers whatever zone the process runs in", () => {
  const formatter = pathToFileURL(join(process.cwd(), "lib/studio-format.ts")).href;
  const inputs = ["2026-01-15T14:00", "2026-07-15T14:00", "2026-09-24T00:00", "2026-03-08T02:30", "2026-11-01T01:30", "2026-02-31T10:00"];
  const script = `const { readWallTime, momentInputValue } = await import(${JSON.stringify(formatter)});
const legacy = (raw) => new Date(raw).toISOString();
console.log(JSON.stringify({
  now: ${JSON.stringify(inputs)}.map((raw) => { const r = readWallTime(raw); return r.ok ? [r.value.toISOString(), momentInputValue(r.value.toISOString())] : r.reason; }),
  legacy: legacy("2026-07-15T14:00"),
}));`;

  const runs = ["UTC", "America/Los_Angeles", "Asia/Tokyo"].map((zone) =>
    JSON.parse(
      execFileSync(process.execPath, [...process.execArgv, "--input-type=module", "-e", script], {
        env: { ...process.env, TZ: zone },
        encoding: "utf8",
      }).trim(),
    ) as { now: unknown[]; legacy: string },
  );

  for (const run of runs) assert.deepEqual(run.now, runs[0]!.now, "a process zone leaked into the answer");
  assert.deepEqual(runs[0]!.now[1], ["2026-07-15T18:00:00.000Z", "2026-07-15T14:00"]);

  // The bug this replaced, measured: the old parse gives three different instants.
  assert.equal(new Set(runs.map((run) => run.legacy)).size, 3);
});

/* ------------------------------------------------------------ one parser */

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test("every datetime-local is read by the one New York parser", () => {
  const fields: string[] = [];
  for (const file of [...sources("app"), ...sources("components"), ...sources("lib")]) {
    const text = readFileSync(file, "utf8");
    if (/type="datetime-local"/.test(text)) fields.push(file);
    // Nothing parses a zoneless string by handing it to Date.
    assert.doesNotMatch(
      text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
      /new Date\((raw|value|String\(|form\.get)/,
      `${file} parses a form value with new Date`,
    );
  }
  assert.deepEqual(fields, [join("components", "studio", "MomentInput.tsx")], "a datetime-local field outside MomentInput");

  const readers = sources("app").filter((file) => readFileSync(file, "utf8").includes("optionalMoment("));
  assert.deepEqual(readers, [join("app", "studio", "(app)", "leads", "actions.ts")]);
});
