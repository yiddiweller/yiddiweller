import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What a signed-in Member actually receives.
 *
 * Not what is visible: what is in the bytes. Build 002 found this the hard way
 * — a guard in a parent layout produced a 404 while the page underneath had
 * already run and shipped its data, and the only place that showed was the RSC
 * flight payload at the bottom of the response. So these read the whole body,
 * markup and payload together, and assert the Owner-only material is not in it.
 *
 * They need a running Studio and two session cookies, which is more than
 * `npm test` should assume, so they only run when told where to look:
 *
 *   STUDIO_BASE_URL=http://localhost:3100 \
 *   STUDIO_OWNER_COOKIE='yw_studio.session_token=…' \
 *   STUDIO_MEMBER_COOKIE='yw_studio.session_token=…' \
 *   STUDIO_CLIENT_ID=… npm test
 *
 * Without those they skip loudly rather than passing quietly, because a test
 * that silently does nothing is worse than no test.
 */

const base = process.env.STUDIO_BASE_URL;
const ownerCookie = process.env.STUDIO_OWNER_COOKIE;
const memberCookie = process.env.STUDIO_MEMBER_COOKIE;
const clientId = process.env.STUDIO_CLIENT_ID;

const configured = Boolean(base && ownerCookie && memberCookie && clientId);
const skip = configured ? false : "set STUDIO_BASE_URL, STUDIO_OWNER_COOKIE, STUDIO_MEMBER_COOKIE and STUDIO_CLIENT_ID";

async function get(path: string, cookie?: string) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return { status: response.status, body: await response.text() };
}

test("an anonymous request never reaches Studio", { skip }, async () => {
  for (const path of ["/studio", "/studio/clients", "/studio/leads", "/studio/audit"]) {
    const { status, body } = await get(path);
    assert.equal(status, 307, path);
    assert.ok(!body.includes("Needs attention"), `${path} leaked its content`);
  }
});

test("Audit answers not found for a Member, and carries none of itself", { skip }, async () => {
  const member = await get("/studio/audit", memberCookie);
  assert.equal(member.status, 404);

  // Not "the heading is absent" — none of the page's data is anywhere in the
  // response, including the flight payload the markup is rebuilt from.
  for (const forbidden of ["Append-only", "client.created", "Client created", "occurredAt"]) {
    assert.ok(!member.body.includes(forbidden), `a Member received ${forbidden}`);
  }

  const owner = await get("/studio/audit", ownerCookie);
  assert.equal(owner.status, 200);
  assert.ok(owner.body.includes("Append-only"), "an Owner should see the page");
});

test("a record's history is Owner-only, and is not fetched for anybody else", { skip }, async () => {
  const member = await get(`/studio/clients/${clientId}`, memberCookie);
  assert.equal(member.status, 200, "a Member may read the client itself");

  for (const forbidden of ["History", "Client created", "What changed, never what it said"]) {
    assert.ok(!member.body.includes(forbidden), `a Member received ${forbidden}`);
  }

  // Archiving is Owner-only too, and the control is not in their page at all.
  assert.ok(!member.body.includes("Archiving"), "a Member received the archive control");

  const owner = await get(`/studio/clients/${clientId}`, ownerCookie);
  assert.ok(owner.body.includes("History"));
  assert.ok(owner.body.includes("Client created"));
});

test("a Member is not offered a link that would answer not found", { skip }, async () => {
  const { body } = await get("/studio", memberCookie);
  assert.ok(!body.includes("/studio/audit"), "the Audit link reached a Member");
});
