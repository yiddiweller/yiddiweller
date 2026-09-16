import assert from "node:assert/strict";
import { test } from "node:test";

import { isWorkroomPath, workroomRedirect, WORKROOM_HOME } from "../lib/client-auth/redirect.ts";

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
