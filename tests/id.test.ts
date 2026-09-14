import assert from "node:assert/strict";
import { test } from "node:test";

import { uuidv7, uuidv7Time } from "../lib/db/id.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test("produces a canonically formatted uuid", () => {
  assert.match(uuidv7(), UUID);
});

test("sets version 7 and the RFC 9562 variant bits", () => {
  for (let i = 0; i < 200; i++) {
    const id = uuidv7();
    assert.equal(id[14], "7", `version nibble wrong in ${id}`);
    assert.ok("89ab".includes(id[19]), `variant nibble wrong in ${id}`);
  }
});

test("embeds the millisecond timestamp so it can be read back", () => {
  for (const ms of [0, 1, 1_700_000_000_000, Date.now(), 2 ** 48 - 1]) {
    assert.equal(uuidv7Time(uuidv7(ms)), ms);
  }
});

test("ids from increasing times sort in time order as plain strings", () => {
  const base = Date.now();
  const ids = [0, 1, 2, 3, 4, 5].map((offset) => uuidv7(base + offset * 1000));
  assert.deepEqual([...ids].sort(), ids);
});

test("ids from the same millisecond are still distinct", () => {
  const now = Date.now();
  const ids = new Set(Array.from({ length: 1000 }, () => uuidv7(now)));
  assert.equal(ids.size, 1000);
});
