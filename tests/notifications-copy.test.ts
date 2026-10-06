import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";

import { clientRevisionUrl, studioRevisionUrl } from "../lib/notifications/links.ts";
import { previewLine, renderNotification } from "../lib/notifications/render.ts";
import { requestDialogMessage, requestedMessage } from "../lib/notifications/request-copy.ts";

/**
 * Stage G2's words and links, pure: what Studio says about the email a
 * request sends, before and after, in every mode; the two links a message may
 * carry; and the one line a redirected preview message adds.
 */

const ROOM = "abcdefghjkmnpqrstvwxyz2345"; // 26 characters, the public-id alphabet
const PRESENTATION = "bcdefghjkmnpqrstvwxyz23456";
const WORKROOM_ID = "0192f0c4-1111-7aaa-8bbb-000000000001";
const PRESENTATION_ID = "0192f0c4-2222-7aaa-8bbb-000000000002";

const saved = { ...process.env };
afterEach(() => {
  for (const key of ["CLIENT_AUTH_URL", "STUDIO_HOST", "APP_URL"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/* ------------------------------------------------------------------ copy */

test("before asking: live names who will be emailed; the preview says no client email is sent", () => {
  assert.equal(
    requestDialogMessage("live"),
    "The client can write on it until you close it. Active client members of this workroom will be emailed a link to this version.",
  );
  assert.match(requestDialogMessage("capture"), /Beta captures notification emails; no client email will be sent\.$/);
  assert.match(requestDialogMessage("redirect"), /test inbox only; no client email will be sent\.$/);
  for (const mode of ["capture", "redirect"] as const) {
    assert.ok(!/will be emailed/.test(requestDialogMessage(mode)), `${mode} claims a client will be emailed`);
  }
});

test("after asking: the exact count, zero said calmly, and the preview never claims a real email", () => {
  const asked = "Asked the client for their thoughts on this version.";
  assert.equal(requestedMessage(1, "live"), `${asked} 1 client member will be emailed.`);
  assert.equal(requestedMessage(3, "live"), `${asked} 3 client members will be emailed.`);
  for (const mode of ["live", "capture", "redirect"] as const) {
    const zero = requestedMessage(0, mode);
    assert.equal(zero, `${asked} No active client members are currently available to email.`);
    assert.ok(!/fail|error|could not/i.test(zero), "zero recipients reads as a failure");
  }
  assert.equal(requestedMessage(2, "capture"), `${asked} Beta captured the email for 2 client members; no client email was sent.`);
  assert.equal(requestedMessage(1, "redirect"), `${asked} The email for 1 client member goes to beta's test inbox only.`);
  for (const n of [1, 2]) {
    for (const mode of ["capture", "redirect"] as const) {
      assert.ok(!/will be emailed/.test(requestedMessage(n, mode)));
    }
  }
});

test("the copy is decided in one place, and Studio's dialog no longer says no email is sent", () => {
  const panel = readFileSync("app/studio/(app)/workrooms/[id]/presentations/ReviewPanel.tsx", "utf8");
  assert.ok(!panel.includes("No email is sent"));
  assert.ok(panel.includes("requestDialogMessage(notificationMode().mode)"));
  const actions = readFileSync("app/studio/(app)/workrooms/[id]/presentations/reviews.ts", "utf8");
  assert.ok(actions.includes("requestedMessage(outcome.value.notified, notificationMode().mode)"));
  // The client's answer never mentions email at all.
  const client = readFileSync("app/workrooms/(room)/[id]/presentations/reviews.ts", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/email/i.test(client.replace(/drainAfterResponse|after-response/g, "")), "the client action talks about email");
});

/* ----------------------------------------------------------------- links */

test("the client link is that exact Revision, on the client origin", () => {
  process.env.CLIENT_AUTH_URL = "https://yiddiweller.com/";
  assert.equal(
    clientRevisionUrl({ room: ROOM, presentation: PRESENTATION, version: 2 }),
    `https://yiddiweller.com/workrooms/${ROOM}/presentations/${PRESENTATION}/revisions/2`,
  );
});

test("the Studio link is that exact Revision and note, on Studio's host — or under /studio without one", () => {
  process.env.STUDIO_HOST = "studio.yiddiweller.com";
  const input = { workroomId: WORKROOM_ID, presentationId: PRESENTATION_ID, version: 2, note: 7 };
  assert.equal(
    studioRevisionUrl(input),
    `https://studio.yiddiweller.com/workrooms/${WORKROOM_ID}/presentations/${PRESENTATION_ID}/revisions/2?note=7`,
  );
  delete process.env.STUDIO_HOST;
  process.env.APP_URL = "https://yiddiweller-beta.up.railway.app";
  assert.equal(
    studioRevisionUrl(input),
    `https://yiddiweller-beta.up.railway.app/studio/workrooms/${WORKROOM_ID}/presentations/${PRESENTATION_ID}/revisions/2?note=7`,
  );
});

test("a link refuses anything that is not a handle, a version or a note", () => {
  process.env.CLIENT_AUTH_URL = "https://yiddiweller.com";
  process.env.STUDIO_HOST = "studio.yiddiweller.com";
  const client = { room: ROOM, presentation: PRESENTATION, version: 2 };
  assert.throws(() => clientRevisionUrl({ ...client, room: "../files/x" }));
  assert.throws(() => clientRevisionUrl({ ...client, presentation: `${PRESENTATION}?x` }));
  assert.throws(() => clientRevisionUrl({ ...client, version: 0 }));
  assert.throws(() => clientRevisionUrl({ ...client, version: 1.5 }));
  const studio = { workroomId: WORKROOM_ID, presentationId: PRESENTATION_ID, version: 2, note: 1 };
  assert.throws(() => studioRevisionUrl({ ...studio, workroomId: ROOM }));
  assert.throws(() => studioRevisionUrl({ ...studio, note: 0 }));
  assert.throws(() => studioRevisionUrl({ ...studio, note: Number.NaN }));
  const built = clientRevisionUrl(client) + studioRevisionUrl(studio);
  for (const forbidden of ["/files/", "/view", "X-Amz", "token", "magic-link", "latest"]) {
    assert.ok(!built.includes(forbidden), `a link carries ${forbidden}`);
  }
});

/* ---------------------------------------------------------- preview line */

test("the preview line names a role only, and only when asked for", () => {
  assert.equal(previewLine("client"), "Preview notification — intended recipient: client member");
  assert.equal(previewLine("studio_inbox"), "Preview notification — intended recipient: studio inbox");
  const view = { presentationTitle: "T", version: 2, url: "https://x.example/w" };
  const plain = renderNotification("review.requested", view);
  assert.ok(!plain.text.includes("Preview notification") && !plain.html.includes("Preview notification"));
  const preview = renderNotification("review.requested", view, { previewFor: "client" });
  assert.ok(preview.text.startsWith(previewLine("client")));
  assert.ok(preview.html.includes(previewLine("client")));
  assert.equal(preview.subject, plain.subject);
  const studio = renderNotification("review.received", { ...view, clientName: "Ana" }, { previewFor: "studio_inbox" });
  assert.ok(studio.text.startsWith(previewLine("studio_inbox")));
});
