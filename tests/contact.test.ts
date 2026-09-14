import assert from "node:assert/strict";
import { test } from "node:test";

import { LIMITS, parsePayload, validate } from "../lib/contact.ts";

const valid = { name: "Ada", email: "ada@example.com", message: "Hello." };

test("accepts a well-formed inquiry", () => {
  assert.deepEqual(validate(valid), {});
});

test("requires every field", () => {
  assert.ok(validate({ ...valid, name: "   " }).name);
  assert.ok(validate({ ...valid, email: "" }).email);
  assert.ok(validate({ ...valid, message: "\n\t " }).message);
});

test("rejects a malformed email address", () => {
  for (const email of ["ada", "ada@", "@example.com", "ada@example", "a b@c.com", "ada@ex .com"]) {
    assert.ok(validate({ ...valid, email }).email, `should reject ${email}`);
  }
});

test("rejects values past their limit but accepts values at it", () => {
  assert.ok(validate({ ...valid, name: "a".repeat(LIMITS.name + 1) }).name);
  assert.equal(validate({ ...valid, name: "a".repeat(LIMITS.name) }).name, undefined);
  assert.ok(validate({ ...valid, message: "a".repeat(LIMITS.message + 1) }).message);
  assert.equal(validate({ ...valid, message: "a".repeat(LIMITS.message) }).message, undefined);
});

test("parses an allowed payload and trims it", () => {
  const parsed = parsePayload({ name: "  Ada  ", email: " ada@example.com ", message: " Hi " });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.fields, { name: "Ada", email: "ada@example.com", message: "Hi" });
  assert.equal(parsed.honeypot, "");
});

test("carries the honeypot through separately", () => {
  const parsed = parsePayload({ ...valid, reference: "bot" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.honeypot, "bot");
});

test("refuses a field it does not know", () => {
  const parsed = parsePayload({ ...valid, status: "new" });
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.equal(parsed.reason, "unknown_field");
});

test("refuses a value that is not a string", () => {
  for (const bad of [{ ...valid, name: 42 }, { ...valid, message: ["a"] }, { ...valid, email: null }]) {
    const parsed = parsePayload(bad);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "wrong_type");
  }
});

test("refuses a body that is not an object", () => {
  for (const bad of [null, [], "string", 7, true]) {
    const parsed = parsePayload(bad);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.equal(parsed.reason, "not_an_object");
  }
});
