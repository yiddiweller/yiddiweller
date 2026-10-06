import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  isStudioPath,
  STUDIO_HOME,
  STUDIO_LOGIN,
  studioLoginPath,
  studioRedirect,
  studioReturn,
} from "../lib/auth/redirect.ts";

/**
 * Where a Studio sign-in can send somebody (Stage G0): a path inside Studio,
 * its query kept, or Studio's root. The client world's twin of this is
 * `workroom-redirect.test.ts`; the two are separate rules on purpose.
 */

const NOTE = "/studio/workrooms/01a0ee9e-8a79-7fb7-939f-c321cfd9e041/presentations/01a0ee9e-8d5a-74e8-a3d8-067e7f813777/revisions/2?note=1";

test("a path inside Studio is kept exactly, its query with it", () => {
  for (const path of [
    "/studio",
    "/studio/",
    "/studio/workrooms/abc",
    "/studio/workrooms?archived=1",
    NOTE,
    "/studio/clients?q=a%20b",
  ]) {
    assert.equal(isStudioPath(path), true, path);
    assert.equal(studioRedirect(path), path, path);
  }
  assert.equal(studioReturn(NOTE), NOTE);
  assert.equal(studioLoginPath(NOTE), `${STUDIO_LOGIN}?next=${encodeURIComponent(NOTE)}`);
  // And the note survives the round trip a login URL makes.
  const back = new URL(`http://x${studioLoginPath(NOTE)}`).searchParams.get("next");
  assert.equal(back, NOTE);
  assert.equal(new URL(`http://x${back}`).searchParams.get("note"), "1");
});

test("the client world is not a Studio destination, nor anywhere else on this origin", () => {
  for (const path of [
    "/workrooms",
    "/workrooms/abc",
    "/workrooms/abc/presentations/def/revisions/2",
    "/",
    "/contact",
    "/api/auth/sign-out",
    "/studios",
    "/studio-archive",
    "/studioclients",
  ]) {
    assert.equal(isStudioPath(path), false, path);
    assert.equal(studioReturn(path), STUDIO_HOME, path);
    assert.equal(studioLoginPath(path), STUDIO_LOGIN, path);
  }
});

test("no destination leaves this origin", () => {
  for (const path of [
    "https://example.com",
    "http://example.com",
    "https://evil.example/studio",
    "//example.com",
    "//evil.example/studio",
    "///example.com",
    "\\\\example.com",
    "/\\example.com",
    "/\\evil.example/studio",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "studio",
    "",
  ]) {
    assert.equal(isStudioPath(path), false, JSON.stringify(path));
    assert.equal(studioRedirect(path), STUDIO_HOME, JSON.stringify(path));
  }
});

test("encoded escapes, climbs and control characters are refused", () => {
  for (const path of [
    "/studio/../workrooms/abc",
    "/studio/..%2fworkrooms",
    "/studio/%2e%2e/workrooms",
    "/studio%2F..%2Fworkrooms",
    "%2F%2Fevil.example",
    "/%2Fevil.example",
    "/studio/%5C%5Cevil.example",
    "https%3A%2F%2Fevil.example",
    "/studio/x\r\nLocation: https://evil.example",
    "/studio/x%0d%0aSet-Cookie:%20a=b",
    "/studio/\tx",
    "/studio/x%00",
    "/studio/x\u007f",
    "/studio/%zz",
    "/studio/" + "a".repeat(2100),
  ]) {
    assert.equal(isStudioPath(path), false, JSON.stringify(path.slice(0, 60)));
    assert.equal(studioReturn(path), STUDIO_HOME, JSON.stringify(path.slice(0, 60)));
  }
});

test("the entrance is never a place to come back to, and nothing at all is home", () => {
  for (const path of [STUDIO_LOGIN, `${STUDIO_LOGIN}?next=%2Fstudio%2Fclients`, `${STUDIO_LOGIN}/x`, STUDIO_HOME]) {
    assert.equal(studioReturn(path), STUDIO_HOME, path);
    assert.equal(studioLoginPath(path), STUDIO_LOGIN, path);
  }
  for (const value of [undefined, null, 0, true, {}, [], [NOTE]]) {
    assert.equal(studioRedirect(value), STUDIO_HOME, JSON.stringify(value) ?? "undefined");
    assert.equal(studioLoginPath(value), STUDIO_LOGIN, JSON.stringify(value) ?? "undefined");
  }
});

test("two rules, not one: neither redirect module knows the other's namespace", () => {
  const studio = readFileSync("lib/auth/redirect.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const client = readFileSync("lib/client-auth/redirect.ts", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(studio, /workrooms|import /, "the Studio rule mentions the client world");
  assert.doesNotMatch(client, /"\/studio|import /, "the client rule mentions Studio");
});

test("both auth instances judge every magic-link callback with their own rule", () => {
  const staff = readFileSync("lib/auth/config.ts", "utf8");
  const client = readFileSync("lib/client-auth/config.ts", "utf8");
  assert.match(staff, /sanitiseCallbacks\(ctx\.body, studioRedirect\)/);
  assert.match(staff, /sanitiseCallbacks\(ctx\.query, studioRedirect\)/);
  assert.match(client, /sanitiseCallbacks\(ctx\.body, workroomRedirect\)/);
  assert.match(client, /sanitiseCallbacks\(ctx\.query, workroomRedirect\)/);
  const helper = readFileSync("lib/auth-callbacks.ts", "utf8");
  for (const key of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) assert.match(helper, new RegExp(`"${key}"`));
});
