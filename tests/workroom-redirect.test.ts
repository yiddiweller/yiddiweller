import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isWorkroomPath,
  WORKROOM_HOME,
  WORKROOM_LOGIN,
  workroomLoginPath,
  workroomRedirect,
  workroomReturn,
} from "../lib/client-auth/redirect.ts";

/**
 * Where a client can be sent by their own sign-in.
 *
 * Better Auth refuses another origin by itself. This is the part it cannot
 * know: that `/studio` is a second product on the same origin, and that a
 * client authentication flow has no business ending anywhere but `/workrooms`.
 *
 * The case that made this a hardening item rather than a theory is in here:
 * `/studio/clients` was accepted, on both halves of the flow.
 */

test("a path inside the client world is kept exactly as asked", () => {
  for (const path of [
    "/workrooms",
    "/workrooms/",
    "/workrooms/01JBXR7Q9K4M2N6P8S0V3W5Y7Z",
    "/workrooms/login",
    "/workrooms?sent=1",
    "/workrooms/01JBXR7Q9K4M2N6P8S0V3W5Y7Z?tab=activity",
  ]) {
    assert.equal(isWorkroomPath(path), true, path);
    assert.equal(workroomRedirect(path), path, path);
  }
});

test("nothing else on this origin is a destination, Studio least of all", () => {
  for (const path of [
    "/studio",
    "/studio/clients",
    "/studio/workrooms/01JBXR7Q9K4M2N6P8S0V3W5Y7Z",
    "/",
    "/contact",
    "/api/client-auth/sign-out",
    "/workroomsomething",
    "/workrooms-archive",
  ]) {
    assert.equal(isWorkroomPath(path), false, path);
    assert.equal(workroomRedirect(path), WORKROOM_HOME, path);
  }
});

test("a prefix that is only the first ten characters climbs back out", () => {
  // `/workrooms/../studio` starts correctly and ends somewhere else, which is
  // why the `..` check runs after decoding and before the prefix test.
  for (const path of [
    "/workrooms/../studio/clients",
    "/workrooms/..%2fstudio/clients",
    "/workrooms/%2e%2e/studio",
    "/workrooms/%2E%2E%2Fstudio",
  ]) {
    assert.equal(isWorkroomPath(path), false, path);
    assert.equal(workroomRedirect(path), WORKROOM_HOME, path);
  }
});

test("no destination leaves this origin", () => {
  for (const path of [
    "https://evil.test/workrooms",
    "//evil.test/workrooms",
    "///evil.test",
    "http:/workrooms",
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "data:text/html,<script>",
    "\\\\evil.test\\workrooms",
    "/\\evil.test/workrooms",
    "workrooms",
    "",
  ]) {
    assert.equal(isWorkroomPath(path), false, JSON.stringify(path));
    assert.equal(workroomRedirect(path), WORKROOM_HOME, JSON.stringify(path));
  }
});

test("a malformed escape is refused rather than guessed at", () => {
  assert.equal(isWorkroomPath("/workrooms/%zz"), false);
  assert.equal(workroomRedirect("/workrooms/%e0%a4%a"), WORKROOM_HOME);
});

test("anything that is not a string at all is simply home", () => {
  for (const value of [undefined, null, 0, 1, true, {}, [], ["/workrooms"]]) {
    assert.equal(workroomRedirect(value), WORKROOM_HOME, JSON.stringify(value) ?? "undefined");
  }
});

/* ----------------------------------------------- G0: coming back after sign-in */

test("G0: an exact version comes back exactly, its query with it", () => {
  for (const path of [
    "/workrooms/abc",
    "/workrooms/abc?x=1",
    "/workrooms/01JBXR7Q9K4M2N6P8S0V3W5Y7Z/presentations/01JBXR7Q9K4M2N6P8S0V3W5Y80/revisions/2",
    "/workrooms/abc?next=https://evil.example", // a query is the page's business, not a destination
  ]) {
    assert.equal(workroomReturn(path), path, path);
    assert.equal(workroomLoginPath(path), `${WORKROOM_LOGIN}?next=${encodeURIComponent(path)}`, path);
  }
});

test("G0: control characters, CR and LF are refused raw and encoded", () => {
  for (const path of [
    "/workrooms/abc\r\nLocation: https://evil.example",
    "/workrooms/abc%0d%0aLocation:%20https://evil.example",
    "/workrooms/abc%0A",
    "/workrooms/\tabc",
    "/workrooms/%09//evil.example",
    "/workrooms/abc\u0000",
    "/workrooms/abc%00",
    "/workrooms/abc\u007f",
  ]) {
    assert.equal(isWorkroomPath(path), false, JSON.stringify(path));
    assert.equal(workroomReturn(path), WORKROOM_HOME, JSON.stringify(path));
  }
});

test("G0: encoded escapes out of the origin or the namespace are refused", () => {
  for (const path of [
    "%2F%2Fevil.example",
    "/%2Fevil.example",
    "/%5Cevil.example",
    "/workrooms/%5C%5Cevil.example",
    "/workrooms%2F..%2Fstudio",
    "https%3A%2F%2Fevil.example",
    "javascript%3Aalert(1)",
    "/%2e%2e/studio",
    "/workrooms/" + "a".repeat(2100),
  ]) {
    assert.equal(isWorkroomPath(path), false, path.slice(0, 60));
    assert.equal(workroomReturn(path), WORKROOM_HOME, path.slice(0, 60));
  }
});

test("G0: the brief's open-redirect matrix, every unsafe value home", () => {
  for (const path of [
    "https://example.com",
    "http://example.com",
    "//example.com",
    "///example.com",
    "\\\\example.com",
    "/\\example.com",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "/studio",
    "/studio/workrooms/abc",
    "/studio/workrooms/a/presentations/b/revisions/2?note=1",
  ]) {
    assert.equal(workroomReturn(path), WORKROOM_HOME, path);
    assert.equal(workroomLoginPath(path), WORKROOM_LOGIN, path);
  }
});

test("G0: the entrance is never a place to come back to, and home needs no next", () => {
  for (const path of [WORKROOM_LOGIN, `${WORKROOM_LOGIN}?next=%2Fworkrooms%2Fabc`, `${WORKROOM_LOGIN}/x`, WORKROOM_HOME]) {
    assert.equal(workroomReturn(path), WORKROOM_HOME, path);
    assert.equal(workroomLoginPath(path), WORKROOM_LOGIN, path);
  }
  for (const value of [null, undefined, "", 42, ["/workrooms/abc"]]) {
    assert.equal(workroomLoginPath(value), WORKROOM_LOGIN, JSON.stringify(value) ?? "undefined");
  }
});
