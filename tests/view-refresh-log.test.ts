import assert from "node:assert/strict";
import { test } from "node:test";

import { logViewRefresh } from "../lib/storage/view-refresh-log.ts";

/**
 * Stage F6.2: the one line a player's recovery leaves in the logs, read back
 * as JSON and checked against the only keys it may ever have.
 */

function captured(run: () => void): Record<string, unknown>[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (line: string) => lines.push(line);
  try {
    run();
  } finally {
    console.log = original;
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

// Everything a request could carry that the line must never repeat.
const SENSITIVE =
  "https://yiddiweller.com/workrooms/wabcdefghijklmnopqrstuvwxy/files/fabcdefghijklmnopqrstuvwxy/view?refresh=7&email=someone%40example.com&key=w/1/f/2/original";

test("a refresh served logs the route and the viewer kind — and nothing else at all", () => {
  for (const [route, type, viewer] of [
    ["client", "audio/x-m4a", "audio"],
    ["studio", "video/quicktime", "video"],
    ["client", "video/webm", "video"],
  ] as const) {
    const lines = captured(() => logViewRefresh(new Request(SENSITIVE), route, type));
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.deepEqual(Object.keys(line!).sort(), ["at", "event", "level", "route", "viewer"]);
    assert.deepEqual({ ...line, at: "…" }, { level: "info", event: "file.view_refreshed", at: "…", route, viewer });
    assert.doesNotMatch(JSON.stringify(line), /abcdefghijklmnopqrstuvwxy|someone|example\.com|original|refresh=|"7"/);
  }
});

test("a request without the marker — an ordinary view — logs nothing", () => {
  for (const url of [
    "https://yiddiweller.com/workrooms/w/files/f/view",
    "https://yiddiweller.com/workrooms/w/files/f/view?other=1",
    "https://yiddiweller.com/workrooms/w/files/f/view?refreshed=1",
  ]) {
    assert.deepEqual(captured(() => logViewRefresh(new Request(url), "client", "audio/wav")), [], url);
  }
});
