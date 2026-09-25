import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { eq } from "drizzle-orm";

import { db } from "../lib/db/index.ts";
import {
  addFileItem,
  createPresentation,
  findPresentation,
  publishPresentation,
} from "../lib/db/presentations.ts";
import { createReviewNote, requestReview } from "../lib/db/reviews.ts";
import { presentationRevisions, workroomFiles } from "../lib/db/schema.ts";
import { file, fixture, open, setUp, skip, tearDown, type Page } from "./support/browser.ts";
import { webm } from "./support/media.ts";
import { owner, person, staff } from "./support/review-stage.ts";

/**
 * An `.mov` plays in the one native video player — Stage F4.0.
 *
 * Every iPhone video is an `.mov`, declared `video/quicktime`, and the exact
 * viewer list did not have that name: beta's *IMG_0044.mov* read *video* in
 * the Files list and was a download card everywhere. `video/quicktime` is now
 * on the list by exact name, and nothing else about QuickTime is.
 *
 * **What this proves, and what it does not.** The *Phone clip* here is declared
 * `video/quicktime` exactly as Safari declares an iPhone's, but its bytes are
 * the committed 8-second VP8 WebM: the bundled Chromium has no H.264 or HEVC
 * decoder, and it plays by the bytes rather than by the declared type
 * (measured: a WebM or an MP4 served as `video/quicktime`, `nosniff` included,
 * loads and reports its duration). So this proves the policy, the routes, the
 * projection, the frozen Revisions and the one `FileViewer` for a file stored
 * as a MOV. **It does not prove that a real QuickTime file's H.264 or HEVC
 * decodes** in any browser — that is the real-beta walk on an iPhone and a
 * desktop Chrome.
 *
 * *QuickTime check*, in the fixture's Workroom:
 *
 *   Version 1   0 The phone clip — frozen as `download`, as every Revision
 *               published before this change froze a MOV
 *   Version 2   0 The phone clip — frozen as `video`
 */

before(async () => {
  await setUp();
  if (!skip) await seedQuickTime();
});
after(tearDown);

const quick = {
  clip: "",
  clipPublic: "",
  undeclaredPublic: "",
  variantPublic: "",
  lookalikePublic: "",
  presentation: "",
  presentationId: "",
  revision1: "",
  revision1Snapshot: null as unknown,
  refusal: "",
};

const publicOf = (id: string) => `f${id.replace(/-/g, "").slice(0, 25)}`;

async function version(pid: string): Promise<number> {
  return (await findPresentation(pid))!.version;
}

async function seedQuickTime(): Promise<void> {
  const workroomId = fixture.workroomId;

  // Declared `video/quicktime`, as an iPhone's is. The bytes stand in — see above.
  const clip = await file(workroomId, "IMG_0044.mov", "video/quicktime", webm());
  // An `.mov` whose browser declared nothing useful, a parameter bolted onto
  // the real name, and a spelling that is not the name. Same playable bytes,
  // so the only difference any route can see is the declared type.
  const undeclared = await file(workroomId, "IMG_0045.mov", "application/octet-stream", webm());
  const variant = await file(workroomId, "IMG_0046.mov", "video/quicktime; codecs=hvc1", webm());
  const lookalike = await file(workroomId, "IMG_0047.mov", "video/x-quicktime", webm());
  for (const id of [undeclared, variant, lookalike]) {
    await db().update(workroomFiles).set({ visibility: "shared", sharedAt: new Date() }).where(eq(workroomFiles.id, id));
  }

  const made = await createPresentation(owner, workroomId, { title: "QuickTime check", intro: "" });
  assert.ok(made.ok);
  const pid = made.value;
  assert.ok((await addFileItem(owner, pid, await version(pid), clip, "The phone clip")).ok);

  // Version 1, as it was published before this change. The publish code of
  // that build is not here to run, so the file is published under a type both
  // policies answer `download` for and label `video` — which freezes exactly
  // `{ kind: "video", viewer: "download" }`, byte for byte what the old list
  // froze for a `video/quicktime` MOV — and then given back its real type.
  await db().update(workroomFiles).set({ contentType: "video/x-quicktime" }).where(eq(workroomFiles.id, clip));
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);
  await db().update(workroomFiles).set({ contentType: "video/quicktime" }).where(eq(workroomFiles.id, clip));
  const revision1 = (await findPresentation(pid))!.currentRevisionId!;

  // A round on Version 1, and a precise time on its MOV: refused, because the
  // viewer that Revision froze is `download` whatever the file is now.
  const round = await requestReview(staff, revision1);
  assert.ok(round.ok);
  const quinn = await person("Quinn", workroomId, "quinn-quicktime@example.test");
  const timed = await createReviewNote(quinn, {
    reviewId: round.value,
    body: "At two seconds.",
    itemPosition: 0,
    anchor: { kind: "time", t: 2 },
  });
  assert.ok(!timed.ok, "a time was stored on a MOV frozen as a download");
  quick.refusal = timed.message;
  // Feedback about it as a whole is unaffected.
  assert.ok((await createReviewNote(quinn, { reviewId: round.value, body: "About the clip.", itemPosition: 0 })).ok);

  // Version 2, published after the change: the same file, frozen as `video`.
  assert.ok((await publishPresentation(owner, pid, await version(pid))).ok);
  const revision2 = (await findPresentation(pid))!.currentRevisionId!;
  assert.ok((await requestReview(staff, revision2)).ok);

  const [row] = await db()
    .select({ snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, revision1));

  Object.assign(quick, {
    clip,
    clipPublic: publicOf(clip),
    undeclaredPublic: publicOf(undeclared),
    variantPublic: publicOf(variant),
    lookalikePublic: publicOf(lookalike),
    presentation: (await findPresentation(pid))!.publicId,
    presentationId: pid,
    revision1,
    revision1Snapshot: row!.snapshot,
  });
}

/** The file one frozen item of a Revision carries. */
async function frozenFile(revisionId: string): Promise<{ kind: string; viewer: string }> {
  const [row] = await db()
    .select({ snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, revisionId));
  const items = (row!.snapshot as { items: { file?: { kind: string; viewer: string } }[] }).items;
  return { kind: items[0]!.file!.kind, viewer: items[0]!.file!.viewer };
}

/* ----------------------------------------------------------------- routes */

async function get(path: string, world: "client" | "studio") {
  const cookie =
    world === "client"
      ? `__Secure-yw_client.session_token=${fixture.clientCookie}`
      : `__Secure-yw_studio.session_token=${fixture.staffCookie}`;
  const response = await fetch(`${process.env.REVIEW_SERVER_URL}${path}`, { headers: { cookie }, redirect: "manual" });
  await response.arrayBuffer();
  return { status: response.status, location: response.headers.get("location") ?? "" };
}

test("the view route signs an exact video/quicktime inline, in both worlds, and nothing like it", { skip }, async () => {
  const client = (id: string) => `/workrooms/${fixture.room}/files/${id}/view`;
  const studio = (id: string) => `/studio/workrooms/${fixture.workroomId}/files/${id}/view`;

  for (const [path, world] of [
    [client(quick.clipPublic), "client"],
    [studio(quick.clipPublic), "studio"],
  ] as const) {
    const view = await get(path, world);
    assert.equal(view.status, 302, `${path} answered ${view.status}`);
    const signed = new URL(view.location);
    assert.equal(signed.searchParams.get("response-content-disposition"), "inline", path);
    assert.equal(signed.searchParams.get("response-content-type"), "video/quicktime", path);
  }

  // The same bytes under any other declaration get no inline address at all.
  for (const id of [quick.undeclaredPublic, quick.variantPublic, quick.lookalikePublic]) {
    assert.equal((await get(client(id), "client")).status, 404, `client ${id}`);
    assert.equal((await get(studio(id), "studio")).status, 404, `studio ${id}`);
    // And every one of them still downloads.
    assert.equal((await get(`/workrooms/${fixture.room}/files/${id}/download`, "client")).status, 302, `download ${id}`);
  }
});

/* ---------------------------------------------------------------- viewers */

/** The phone clip's block: its `<video>`, and whether a card stands in for it. */
async function clipBlock(page: Page) {
  return page.evaluate(() => {
    const download = [...document.querySelectorAll("a")].find((a) => a.textContent === "Download IMG_0044.mov");
    const piece = download?.closest("section") ?? document.querySelector("main");
    const video = piece?.querySelector("video") ?? null;
    return {
      video: Boolean(video),
      controls: video?.controls ?? false,
      autoplay: video?.autoplay ?? false,
      paused: video?.paused ?? true,
      preload: video?.getAttribute("preload") ?? "",
      playsInline: video?.hasAttribute("playsinline") ?? false,
      src: video?.getAttribute("src") ?? "",
      card: Boolean(piece?.textContent?.includes("No preview for this kind of file")),
      download: Boolean(download),
      videos: document.querySelectorAll("video").length,
    };
  });
}

async function loads(page: Page): Promise<number> {
  await page.waitForFunction(
    () => {
      const video = document.querySelector("video");
      return video && video.readyState >= 1 && Number.isFinite(video.duration);
    },
    undefined,
    { timeout: 10_000 },
  );
  return page.evaluate(() => document.querySelector("video")!.duration);
}

test("the Files viewer plays it in the one native player, in both worlds, and never on its own", { skip }, async () => {
  for (const [path, route] of [
    [`/workrooms/${fixture.room}/files/${quick.clipPublic}`, `/workrooms/${fixture.room}/files/${quick.clipPublic}/view`],
    [
      `/studio/workrooms/${fixture.workroomId}/files/${quick.clipPublic}`,
      `/studio/workrooms/${fixture.workroomId}/files/${quick.clipPublic}/view`,
    ],
  ] as const) {
    const { page, errors } = await open(path);
    const block = await clipBlock(page);
    assert.ok(block.video && block.controls, `${path}: no native player`);
    assert.ok(!block.card, `${path}: a download card`);
    assert.equal(block.videos, 1, `${path}: a second player`);
    assert.equal(block.src, route, `${path}: not our own view route`);
    assert.equal(block.preload, "metadata");
    assert.ok(block.playsInline, `${path}: not playsinline`);
    assert.ok(!block.autoplay, `${path}: autoplay`);
    assert.ok(Math.abs((await loads(page)) - 8) < 0.1, `${path}: the stand-in did not load`);
    await page.waitForTimeout(300);
    assert.ok((await clipBlock(page)).paused, `${path}: it started playing`);
    assert.deepEqual(errors, []);
    await page.context().close();
  }
});

test("a MOV that is not exactly video/quicktime is a download card on its Files page", { skip }, async () => {
  for (const id of [quick.undeclaredPublic, quick.variantPublic, quick.lookalikePublic]) {
    const { page } = await open(`/workrooms/${fixture.room}/files/${id}`);
    assert.equal(await page.locator("video").count(), 0, `${id} has a player`);
    assert.equal(await page.getByText("No preview for this kind of file.").count(), 1, `${id} has no card`);
    await page.context().close();
  }
});

/* ------------------------------------------------------------- Revisions */

test("a Revision frozen as a download stays one; the next one published is a player", { skip }, async () => {
  const presentation = (await findPresentation(quick.presentationId))!;
  assert.deepEqual(await frozenFile(quick.revision1), { kind: "video", viewer: "download" });
  assert.deepEqual(await frozenFile(presentation.currentRevisionId!), { kind: "video", viewer: "video" });

  const client = `/workrooms/${fixture.room}/presentations/${quick.presentation}`;
  const studio = `/studio/workrooms/${fixture.workroomId}/presentations/${quick.presentationId}`;

  for (const path of [`${client}/revisions/1`, `${studio}/revisions/1`]) {
    const { page, errors } = await open(path);
    const block = await clipBlock(page);
    assert.ok(block.card && !block.video, `${path}: Version 1 is no longer the card it was published as`);
    assert.ok(block.download, `${path}: Version 1 lost its download`);
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  for (const path of [client, `${client}/revisions/2`, `${studio}/revisions/2`]) {
    const { page, errors } = await open(path);
    const block = await clipBlock(page);
    assert.ok(block.video && block.controls && !block.card, `${path}: Version 2 is not a player`);
    assert.ok(block.download, `${path}: the download link is gone from under the player`);
    assert.ok(!block.autoplay);
    assert.ok(Math.abs((await loads(page)) - 8) < 0.1, `${path}: the stand-in did not load`);
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // Nothing was rewritten: Version 1's snapshot is what it was when published.
  const [row] = await db()
    .select({ snapshot: presentationRevisions.snapshot })
    .from(presentationRevisions)
    .where(eq(presentationRevisions.id, quick.revision1));
  assert.deepEqual(row!.snapshot, quick.revision1Snapshot);
});

test("a precise time on a MOV frozen as a download is refused, as for any download", { skip }, () => {
  assert.equal(quick.refusal, "This kind of file takes feedback as a whole, not at a point in it.");
});

test("no precise time is offered for a MOV in this slice — Review capture is unchanged", { skip }, async () => {
  const { page, errors } = await open(`/workrooms/${fixture.room}/presentations/${quick.presentation}`);
  assert.ok((await clipBlock(page)).video, "the current version has no player");
  await page.getByLabel("About").selectOption({ label: "The phone clip" });
  assert.equal(await page.getByRole("button", { name: /^Set precise time/ }).count(), 0, "video capture appeared early");
  assert.deepEqual(errors, []);
  await page.context().close();
});
