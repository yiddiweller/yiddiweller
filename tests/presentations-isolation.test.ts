import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What a client actually receives when a Presentation is involved, in bytes.
 *
 * The same discipline as `files-isolation.test.ts`: not what is visible, but
 * the whole response — markup, RSC flight payload, headers and title together.
 * A draft caption sitting in a flight payload is invisible on screen and fully
 * readable in `view-source`, and Build 003 found exactly that class of leak in
 * a redirect body.
 *
 * Needs a running deployment seeded with two clients, two Workrooms and four
 * Presentations — published with history, draft, withdrawn, and one belonging
 * to the other tenant:
 *
 *   WORKROOM_BASE_URL=http://localhost:3100 \
 *   WORKROOM_A_COOKIE=… WORKROOM_A_ID=… WORKROOM_B_COOKIE=… WORKROOM_B_ID=… \
 *   STUDIO_OWNER_COOKIE=… STUDIO_WORKROOM_A_ID=… \
 *   PRESENTATION_A=… PRESENTATION_A_ID=… PRESENTATION_A_DRAFT=… \
 *   PRESENTATION_A_DRAFT_ID=… PRESENTATION_A_WITHDRAWN=… PRESENTATION_B=… \
 *   WORKROOM_A_SVG=… npm test
 */

const base = process.env.WORKROOM_BASE_URL;
const clientA = process.env.WORKROOM_A_COOKIE;
const clientB = process.env.WORKROOM_B_COOKIE;
const roomA = process.env.WORKROOM_A_ID;
const roomB = process.env.WORKROOM_B_ID;
const staff = process.env.STUDIO_OWNER_COOKIE;
const studioRoomA = process.env.STUDIO_WORKROOM_A_ID;

/** Published twice. */
const shown = process.env.PRESENTATION_A;
const shownId = process.env.PRESENTATION_A_ID;
/** Never published, and holding an internal file behind marker strings. */
const draft = process.env.PRESENTATION_A_DRAFT;
const draftId = process.env.PRESENTATION_A_DRAFT_ID;
/** Published, then withdrawn. Its history must go with it. */
const withdrawn = process.env.PRESENTATION_A_WITHDRAWN;
/** The other tenant's. */
const theirs = process.env.PRESENTATION_B;
const svgA = process.env.WORKROOM_A_SVG;
/** Internal, unpublished, one per viewer kind — all inside the draft. */
const internalImage = process.env.WORKROOM_A_INTERNAL_IMAGE;
const internalPdf = process.env.WORKROOM_A_INTERNAL_PDF;
const internalVideo = process.env.WORKROOM_A_INTERNAL_VIDEO;
const internalAudio = process.env.WORKROOM_A_INTERNAL_AUDIO;
const internalSource = process.env.WORKROOM_A_INTERNAL_SOURCE;
const internalSvg = process.env.WORKROOM_A_INTERNAL_SVG;

const configured = Boolean(
  base && clientA && clientB && roomA && roomB && staff && studioRoomA && shown && shownId &&
    draft && draftId && withdrawn && theirs && svgA && internalImage && internalPdf &&
    internalVideo && internalAudio && internalSource && internalSvg,
);
const skip = configured
  ? false
  : "set WORKROOM_BASE_URL, WORKROOM_{A,B}_COOKIE, WORKROOM_{A,B}_ID, STUDIO_OWNER_COOKIE, STUDIO_WORKROOM_A_ID, PRESENTATION_A, PRESENTATION_A_ID, PRESENTATION_A_DRAFT, PRESENTATION_A_DRAFT_ID, PRESENTATION_A_WITHDRAWN, PRESENTATION_B and WORKROOM_A_SVG";

/** Seeded into every internal field. None may appear in any client response. */
const MARKERS = [
  "MARKER-CLIENT-NOTE",
  "MARKER-CONTACT-NOTE",
  "MARKER-PROJECT-NOTE",
  "MARKER-PROJECT-DESCRIPTION",
  "MARKER-ORIGINAL-FILENAME",
  "MARKER-DRAFT-TITLE",
  "MARKER-DRAFT-INTRO",
  "MARKER-DRAFT-CAPTION",
];

async function get(path: string, cookie?: string) {
  const response = await fetch(`${base}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    body: await response.text(),
    location: response.headers.get("location") ?? "",
    cacheControl: response.headers.get("cache-control") ?? "",
  };
}

function leaks(body: string, extra: string[] = []): string[] {
  return [...MARKERS, ...extra].filter((marker) => body.includes(marker));
}

const client = (p: string) => `/workrooms/${roomA}/presentations${p}`;

/* ------------------------------------------------------- what is reachable */

test("only what was published to this workroom is reachable", { skip }, async () => {
  const list = await get(client(""), clientA);
  assert.equal(list.status, 200);
  assert.match(list.body, /Brand direction/);
  assert.ok(!list.body.includes("Motion study</"), "a draft was listed");
  assert.ok(!list.body.includes("Early thinking"), "a withdrawn presentation was listed");
  assert.deepEqual(leaks(list.body), []);

  // A draft has no client-facing address at all, and neither has its history.
  for (const path of [`/${draft}`, `/${draft}/revisions`, `/${draft}/revisions/1`]) {
    const refused = await get(client(path), clientA);
    assert.equal(refused.status, 404, `${path} was reachable`);
    assert.deepEqual(leaks(refused.body), [], `${path} leaked`);
  }

  // Withdrawing takes the whole Presentation back, history included.
  for (const path of [`/${withdrawn}`, `/${withdrawn}/revisions`, `/${withdrawn}/revisions/1`]) {
    assert.equal((await get(client(path), clientA)).status, 404, `${path} survived a withdrawal`);
  }
});

test("a client reads the published revision, never the draft behind it", { skip }, async () => {
  const current = await get(client(`/${shown}`), clientA);
  assert.equal(current.status, 200);
  assert.match(current.body, /Brand direction/);
  assert.match(current.body, /Second pass, after your notes/, "the current revision was not version 2");
  assert.deepEqual(leaks(current.body), []);

  const first = await get(client(`/${shown}/revisions/1`), clientA);
  assert.equal(first.status, 200);
  assert.match(
    first.body,
    /Here is the direction we developed based on our conversation/,
    "version 1 rendered version 2's words",
  );
  assert.ok(
    !first.body.includes("Second pass, after your notes"),
    "a historical revision was rebuilt from current rows",
  );

  // A version nobody published is not a version, and neither is nonsense.
  for (const n of ["3", "99", "0", "-1", "abc", "1e3"]) {
    assert.equal((await get(client(`/${shown}/revisions/${n}`), clientA)).status, 404, `revision ${n}`);
  }
});

/* ------------------------------------------------------- tenant isolation */

test("one client's presentations reach nothing of another's", { skip }, async () => {
  // Their id under my room, their id under their room with my cookie, and the
  // reverse — all four combinations, in both directions.
  const attempts = [
    [`/workrooms/${roomA}/presentations/${theirs}`, clientA],
    [`/workrooms/${roomB}/presentations/${theirs}`, clientA],
    [`/workrooms/${roomB}/presentations/${shown}`, clientB],
    [`/workrooms/${roomA}/presentations/${shown}`, clientB],
    [`/workrooms/${roomA}/presentations/${theirs}/revisions/1`, clientA],
    [`/workrooms/${roomB}/presentations`, clientA],
  ] as const;

  for (const [path, cookie] of attempts) {
    const response = await get(path, cookie);
    assert.ok(
      response.status === 404 || response.status === 307,
      `${path} answered ${response.status}`,
    );
    // Not the bare word "Birch": that is the other client's own name, and
    // their own header is allowed to say it to them.
    assert.deepEqual(
      leaks(response.body, ["MARKER-B-INTRO", "Birch direction", "Birch guidelines"]),
      [],
      `${path} leaked`,
    );
  }

  // And the list each of them does get holds only their own.
  const mine = await get(`/workrooms/${roomA}/presentations`, clientA);
  assert.ok(!mine.body.includes("Birch direction"));
  const yours = await get(`/workrooms/${roomB}/presentations`, clientB);
  assert.ok(!yours.body.includes("Brand direction"));
});

test("neither session is a way into the other product", { skip }, async () => {
  // A Studio session is not a client. It gets the sign-in redirect an
  // anonymous request gets, which is the point: it learns nothing extra.
  const staffAtClient = await get(client(`/${shown}`), staff);
  assert.equal(staffAtClient.status, 307);
  assert.deepEqual(leaks(staffAtClient.body), []);

  const anonymous = await get(client(`/${shown}`), undefined);
  assert.equal(anonymous.status, 307);
  assert.equal(
    anonymous.location.split("?")[0],
    staffAtClient.location.split("?")[0],
    "a studio session was told something an anonymous request was not",
  );

  // And a client session is not staff.
  for (const path of [
    `/studio/workrooms/${studioRoomA}/presentations`,
    `/studio/workrooms/${studioRoomA}/presentations/${shownId}`,
    `/studio/workrooms/${studioRoomA}/presentations/${shownId}/preview`,
    `/studio/workrooms/${studioRoomA}/presentations/${draftId}/preview`,
  ]) {
    const withClient = await get(path, clientA);
    const anon = await get(path, undefined);

    // A Studio page refuses by sending an unauthenticated caller to sign in,
    // so the number itself is not the property worth asserting. What is: a
    // client session is told **exactly** what a stranger is told, and neither
    // is told anything about the work.
    assert.equal(
      `${withClient.status} ${withClient.location.split("?")[0]}`,
      `${anon.status} ${anon.location.split("?")[0]}`,
      `${path} treated a client session as something other than a stranger`,
    );
    assert.ok(withClient.status === 404 || withClient.status === 307, `${path} answered ${withClient.status}`);
    assert.deepEqual(leaks(withClient.body), [], `${path} leaked to a client`);
    assert.ok(!withClient.body.includes("Brand direction"), `${path} named the work to a client`);
  }
});

/* --------------------------------------------------- metadata and headers */

test("a presentation says nothing in its title, to anybody", { skip }, async () => {
  for (const [path, cookie] of [
    [client(""), clientA],
    [client(`/${shown}`), clientA],
    [client(`/${shown}/revisions`), clientA],
    [client(`/${shown}/revisions/1`), clientA],
    [client(`/${draft}`), clientA],
    [client(`/${shown}`), undefined],
  ] as const) {
    const response = await get(path, cookie);
    const title = /<title>([^<]*)<\/title>/.exec(response.body)?.[1] ?? "";
    assert.ok(
      title === "" || title === "Workroom — Yiddi Weller" || title === "Yiddi Weller",
      `${path} produced the title ${JSON.stringify(title)}`,
    );
    assert.ok(!title.includes("Brand direction"), `${path} put the work in its title`);
  }
});

test("a presentation response is never stored by anything in between", { skip }, async () => {
  for (const path of [client(""), client(`/${shown}`), client(`/${shown}/revisions/1`)]) {
    const response = await get(path, clientA);
    assert.match(response.cacheControl, /private/, path);
    assert.match(response.cacheControl, /no-store/, path);
  }
});

test("no storage address and no signed URL reaches the page", { skip }, async () => {
  for (const [path, cookie] of [
    [client(`/${shown}`), clientA],
    [client(`/${shown}/revisions/1`), clientA],
    [`/studio/workrooms/${studioRoomA}/presentations/${shownId}/preview`, staff],
    [`/studio/workrooms/${studioRoomA}/presentations/${shownId}/revisions/1`, staff],
  ] as const) {
    const response = await get(path, cookie);
    assert.equal(response.status, 200, path);
    for (const forbidden of ["X-Amz-Signature", "X-Amz-Credential", "pending/", "storage_key", "storageKey"]) {
      assert.ok(!response.body.includes(forbidden), `${path} carried ${forbidden}`);
    }
    // The permanent key prefix, which would be a bucket address in the markup.
    assert.ok(!/["'(]w\/[0-9a-f]{8}-/.test(response.body), `${path} carried a storage key`);
  }
});

/* -------------------------------------------------------- the viewer rule */

test("a presentation composes Stage A's viewer and never decides for itself", { skip }, async () => {
  const page = await get(client(`/${shown}`), clientA);
  assert.equal(page.status, 200);

  // One element per kind, each pointing at our own route rather than storage.
  assert.match(page.body, /<img[^>]+viewerImage[^>]+\/files\/[a-z0-9]{26}\/view/, "no image viewer");
  assert.match(page.body, /<video[^>]+\/files\/[a-z0-9]{26}\/view/, "no video viewer");
  assert.match(page.body, /<iframe[^>]+\/files\/[a-z0-9]{26}\/view/, "no pdf viewer");

  // The unsupported source file is a card, not an empty frame.
  assert.match(page.body, /No preview for this kind of file/);

  // Download is offered for every file in the presentation, without exception.
  // Counted as distinct paths, not occurrences: every route appears twice in
  // a response, once in the markup and once in the RSC flight payload.
  const distinct = (pattern: RegExp) => new Set(page.body.match(pattern) ?? []).size;
  assert.equal(distinct(/\/files\/[a-z0-9]{26}\/download/g), 4, "a file lost its download");
  assert.equal(distinct(/\/files\/[a-z0-9]{26}\/view/g), 3, "the wrong number of files render inline");

  // Nothing starts on its own.
  assert.ok(!page.body.includes("autoplay"), "something autoplays");
  assert.match(page.body, /preload="metadata"/);
});

test("an SVG is never rendered inline, wherever it appears", { skip }, async () => {
  // Not in the presentation, which holds no SVG, and not on its own page.
  const viewer = await get(`/workrooms/${roomA}/files/${svgA}`, clientA);
  assert.equal(viewer.status, 200);
  assert.match(viewer.body, /No preview for this kind of file/);
  assert.ok(!/<img[^>]+\/files\/[a-z0-9]{26}\/view/.test(viewer.body), "an SVG was put in an img");
  assert.ok(!/<iframe[^>]+\/files\/[a-z0-9]{26}\/view/.test(viewer.body), "an SVG was put in an iframe");
  assert.ok(!viewer.body.includes("<object"), "an SVG was put in an object");
  assert.ok(!viewer.body.includes("<embed"), "an SVG was put in an embed");

  // And the route that serves inline bytes refuses it outright, which is what
  // actually holds — the markup merely never asks.
  assert.equal((await get(`/workrooms/${roomA}/files/${svgA}/view`, clientA)).status, 404);
});

/* ------------------------------------------------------------ the preview */

test("the staff preview is the draft, and the client's page is the published version", { skip }, async () => {
  const preview = await get(`/studio/workrooms/${studioRoomA}/presentations/${shownId}/preview`, staff);
  assert.equal(preview.status, 200);
  assert.match(preview.body, /Draft — not published/);
  assert.match(preview.body, /This is the draft, in the client&#x27;s view|This is the draft, in the client’s view/);

  // The draft of a published presentation is allowed to differ, and does not
  // change the client's page. Both are rendered by the one component, so the
  // structure the client gets is the structure the preview shows.
  const clientPage = await get(client(`/${shown}`), clientA);
  for (const marker of ["presentationFlow", "presentationPiece", "presentationNote"]) {
    assert.ok(preview.body.includes(marker), `the preview lost ${marker}`);
    assert.ok(clientPage.body.includes(marker), `the client page lost ${marker}`);
  }

  // The preview of a never-published draft holds its content, and that content
  // has never appeared on any client surface — the markers prove it.
  const draftPreview = await get(`/studio/workrooms/${studioRoomA}/presentations/${draftId}/preview`, staff);
  assert.equal(draftPreview.status, 200);
  assert.match(draftPreview.body, /MARKER-DRAFT-CAPTION/, "the preview is not showing the draft");
});

test("the staff preview and the client page cannot drift apart", { skip }, async () => {
  // A structural guard rather than a visual one: both surfaces must render the
  // same set of section classes from `PresentationView`. Stage A's preview fell
  // a whole feature behind because two copies of the markup existed; this fails
  // the moment a second copy appears and only one of them is changed.
  const clientPage = await get(client(`/${shown}`), clientA);
  const staffPage = await get(`/studio/workrooms/${studioRoomA}/presentations/${shownId}/revisions/2`, staff);

  const classes = (body: string) =>
    [...new Set((body.match(/__presentation[A-Za-z]+/g) ?? []).map((name) => name.replace(/^__/, "")))].sort();

  const mine = classes(clientPage.body);
  assert.ok(mine.length >= 4, `the client page rendered ${mine.length} presentation classes`);
  assert.deepEqual(
    classes(staffPage.body).filter((name) => name !== "presentationNotice"),
    mine.filter((name) => name !== "presentationNotice"),
    "staff and client rendered different presentation structures",
  );
});

/* ----------------------------------------------------------- the public site */

test("the public site is untouched by any of it", { skip }, async () => {
  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.ok(!robots.body.includes("presentations"), "robots grew a second private prefix");
  assert.match(robots.body, /Disallow: \/workrooms/);

  for (const path of ["/", "/work", "/contact"]) {
    const page = await get(path);
    assert.equal(page.status, 200, path);
    assert.deepEqual(leaks(page.body, ["Brand direction", "Birch direction"]), [], path);
    assert.ok(!page.body.includes("Presentation"), `${path} mentions the private product`);
  }

  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.ok(!sitemap.body.includes("presentations"), "a private route reached the sitemap");
});

/* ------------------------------------------------ the preview's own routes */

/**
 * The defect manual beta acceptance found, and the wider one it was hiding.
 *
 * Studio Preview handed the client's file routes to a staff browser. For an
 * internal file that is a broken image — the client route correctly refuses
 * anything unshared. For a *published* Revision it was broken too, because a
 * Studio session on a `/workrooms/...` route is sent to the client sign-in
 * exactly as a stranger is. Authority decides the route; the file's visibility
 * decides nothing about which route a surface uses.
 */

test("the staff preview renders every internal kind, through staff routes", { skip }, async () => {
  const preview = await get(`/studio/workrooms/${studioRoomA}/presentations/${draftId}/preview`, staff);
  assert.equal(preview.status, 200);

  const studioPaths = new Set(preview.body.match(/\/studio\/workrooms\/[0-9a-f-]{36}\/files\/[a-z0-9]{26}\/[a-z]+/g) ?? []);
  assert.ok(studioPaths.size > 0, "the preview emitted no staff file routes at all");

  // Not one client route anywhere in the response, markup or flight payload.
  assert.equal(
    (preview.body.match(/\/workrooms\/[a-z0-9]{26}\/files\//g) ?? []).length,
    0,
    "the preview handed a staff browser the client's file routes",
  );

  // Every kind renders, and every one of them fetches successfully as staff.
  assert.match(preview.body, /<img[^>]+viewerImage/, "no image viewer in the preview");
  assert.match(preview.body, /<iframe[^>]+viewerFrame/, "no pdf viewer in the preview");
  assert.match(preview.body, /<video/, "no video viewer in the preview");
  assert.match(preview.body, /<audio/, "no audio viewer in the preview");
  assert.match(preview.body, /No preview for this kind of file/, "no download card in the preview");

  for (const path of studioPaths) {
    const response = await get(path, staff);
    assert.ok(
      response.status === 302 || response.status === 200,
      `${path} answered ${response.status} to the staff session that rendered it`,
    );
  }
});

test("each internal kind is reachable by staff and by nobody else", { skip }, async () => {
  for (const [kind, id] of [
    ["image", internalImage],
    ["pdf", internalPdf],
    ["video", internalVideo],
    ["audio", internalAudio],
  ] as const) {
    assert.equal(
      (await get(`/studio/workrooms/${studioRoomA}/files/${id}/view`, staff)).status,
      302,
      `staff could not view the internal ${kind}`,
    );
    assert.equal(
      (await get(`/studio/workrooms/${studioRoomA}/files/${id}/download`, staff)).status,
      302,
      `staff could not download the internal ${kind}`,
    );

    // The client cannot reach it by any route, before publication.
    for (const suffix of ["", "/view", "/download", "/preview"]) {
      assert.equal(
        (await get(`/workrooms/${roomA}/files/${id}${suffix}`, clientA)).status,
        404,
        `a client reached the internal ${kind} at ${suffix || "its page"}`,
      );
    }
  }

  // An unsupported source file has no viewer either way, and downloads both.
  assert.equal((await get(`/studio/workrooms/${studioRoomA}/files/${internalSource}/view`, staff)).status, 404);
  assert.equal((await get(`/studio/workrooms/${studioRoomA}/files/${internalSource}/download`, staff)).status, 302);

  // And an internal SVG stays download-only for staff too: the inline rule
  // protects the person looking, not the tenancy.
  assert.equal((await get(`/studio/workrooms/${studioRoomA}/files/${internalSvg}/view`, staff)).status, 404);
  assert.equal((await get(`/studio/workrooms/${studioRoomA}/files/${internalSvg}/download`, staff)).status, 302);
});

test("staff cannot preview another workroom's file through its own routes", { skip }, async () => {
  const other = process.env.STUDIO_WORKROOM_B_ID;
  if (!other) return;

  // The file exists and staff are staff — and the route still refuses,
  // because the Workroom in the path is not the Workroom the file is in.
  for (const suffix of ["/view", "/download", "/preview"]) {
    assert.equal(
      (await get(`/studio/workrooms/${other}/files/${internalImage}${suffix}`, staff)).status,
      404,
      `a staff route served workroom A's file under workroom B${suffix}`,
    );
  }

  // And a client session cannot use a Studio viewer route at all.
  for (const suffix of ["/view", "/download", "/preview"]) {
    const response = await get(`/studio/workrooms/${studioRoomA}/files/${internalImage}${suffix}`, clientA);
    assert.equal(response.status, 404, `a client used the studio route${suffix}`);
  }
});

test("a staff presentation surface carries no storage address either", { skip }, async () => {
  for (const path of [
    `/studio/workrooms/${studioRoomA}/presentations/${draftId}/preview`,
    `/studio/workrooms/${studioRoomA}/presentations/${shownId}/preview`,
    `/studio/workrooms/${studioRoomA}/presentations/${shownId}/revisions/1`,
  ]) {
    const response = await get(path, staff);
    assert.equal(response.status, 200, path);
    assert.match(response.cacheControl, /private/, path);
    for (const forbidden of ["X-Amz-Signature", "X-Amz-Credential", "BUCKET_", "pending/", "storage_key"]) {
      assert.ok(!response.body.includes(forbidden), `${path} carried ${forbidden}`);
    }
    assert.ok(!/["'(]w\/[0-9a-f]{8}-/.test(response.body), `${path} carried a storage key`);
    // The bucket's own address, whatever it is configured to be.
    assert.ok(!/https?:\/\/[^"'\s]*(amazonaws|railway|r2\.cloudflare|127\.0\.0\.1:\d+\/test-bucket)/.test(response.body), `${path} carried the bucket endpoint`);
  }
});

test("the published revision renders for staff, with staff routes", { skip }, async () => {
  // The wider half of the same defect: every file in a published Revision is
  // shared, and staff still could not fetch one, because they were handed the
  // client's routes.
  const page = await get(`/studio/workrooms/${studioRoomA}/presentations/${shownId}/revisions/1`, staff);
  assert.equal(page.status, 200);

  const studioPaths = new Set(page.body.match(/\/studio\/workrooms\/[0-9a-f-]{36}\/files\/[a-z0-9]{26}\/[a-z]+/g) ?? []);
  assert.ok(studioPaths.size >= 4, `expected staff routes for every file, found ${studioPaths.size}`);
  assert.equal(
    (page.body.match(/\/workrooms\/[a-z0-9]{26}\/files\//g) ?? []).length,
    0,
    "a staff page handed out client file routes",
  );

  for (const path of studioPaths) {
    assert.equal((await get(path, staff)).status, 302, `${path} did not resolve for staff`);
  }

  // The client reads the same Revision through the client's routes, and every
  // one of those resolves for them.
  const clientPage = await get(client(`/${shown}/revisions/1`), clientA);
  const clientPaths = new Set(clientPage.body.match(/\/workrooms\/[a-z0-9]{26}\/files\/[a-z0-9]{26}\/[a-z]+/g) ?? []);
  assert.ok(clientPaths.size >= 3);
  assert.equal((clientPage.body.match(/\/studio\//g) ?? []).length, 0, "a studio path reached the client");
  for (const path of clientPaths) {
    assert.equal((await get(path, clientA)).status, 302, `${path} did not resolve for the client`);
  }
});
