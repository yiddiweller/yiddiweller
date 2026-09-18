import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * What a client actually receives when files are involved, in bytes.
 *
 * The same discipline as `workroom-isolation.test.ts`: not what is visible, but
 * the whole response — markup, RSC flight payload, headers and title together.
 * Build 003 found a leak that was invisible in rendered text and sat in a
 * redirect body, and a storage key in a flight payload would be the same class
 * of mistake with a worse consequence.
 *
 * Needs a running deployment with two signed-in clients, two workrooms and at
 * least one shared file, which is more than `npm test` should assume:
 *
 *   WORKROOM_BASE_URL=http://localhost:3100 \
 *   WORKROOM_A_COOKIE=… WORKROOM_A_ID=… WORKROOM_A_FILE=… \
 *   WORKROOM_A_INTERNAL_FILE=… \
 *   WORKROOM_B_COOKIE=… WORKROOM_B_ID=… WORKROOM_B_FILE=… \
 *   STUDIO_OWNER_COOKIE=… npm test
 */

const base = process.env.WORKROOM_BASE_URL;
const clientA = process.env.WORKROOM_A_COOKIE;
const clientB = process.env.WORKROOM_B_COOKIE;
const roomA = process.env.WORKROOM_A_ID;
const roomB = process.env.WORKROOM_B_ID;
const fileA = process.env.WORKROOM_A_FILE;
const fileB = process.env.WORKROOM_B_FILE;
const internalA = process.env.WORKROOM_A_INTERNAL_FILE;
const staff = process.env.STUDIO_OWNER_COOKIE;
/** The Workroom's internal id, which is what Studio routes are keyed by. */
const studioRoomA = process.env.STUDIO_WORKROOM_A_ID;
/** A shared PNG with a browser-made preview, and an SVG with none. */
const imageA = process.env.WORKROOM_A_IMAGE;
const svgA = process.env.WORKROOM_A_SVG;
const internalImageA = process.env.WORKROOM_A_INTERNAL_IMAGE;
/** A shared PDF, video, audio track and an unsupported source file. */
const pdfA = process.env.WORKROOM_A_PDF;
const videoA = process.env.WORKROOM_A_VIDEO;
const audioA = process.env.WORKROOM_A_AUDIO;
const sourceA = process.env.WORKROOM_A_SOURCE;
const archivedA = process.env.WORKROOM_A_ARCHIVED;

const configured = Boolean(
  base && clientA && clientB && roomA && roomB && fileA && fileB && internalA && staff &&
    studioRoomA && imageA && svgA && internalImageA && pdfA && videoA && audioA && sourceA &&
    archivedA,
);
const skip = configured
  ? false
  : "set WORKROOM_BASE_URL, WORKROOM_{A,B}_COOKIE, WORKROOM_{A,B}_ID, WORKROOM_{A,B}_FILE, WORKROOM_A_INTERNAL_FILE, STUDIO_OWNER_COOKIE, STUDIO_WORKROOM_A_ID, WORKROOM_A_IMAGE, WORKROOM_A_SVG and WORKROOM_A_INTERNAL_IMAGE";

/** Seeded into every internal field. None may appear in any client response. */
const MARKERS = [
  "MARKER-CLIENT-NOTE",
  "MARKER-CONTACT-NOTE",
  "MARKER-PROJECT-NOTE",
  "MARKER-PROJECT-DESCRIPTION",
  "MARKER-LEAD-SUMMARY",
  "MARKER-ORIGINAL-FILENAME",
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

test("a client's files page carries nothing internal", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, clientA);
  assert.equal(page.status, 200);

  assert.deepEqual(leaks(page.body), [], "an internal field reached the client");
  // The two things a file adds to the leak surface.
  assert.ok(!page.body.includes("pending/"), "a pending storage key reached the client");
  assert.ok(!/\bw\/[0-9a-f-]{36}\/f\//.test(page.body), "a permanent storage key reached the client");
  assert.ok(!page.body.includes("Birch"), "another tenant reached the client");
  assert.ok(!page.body.includes("/studio/"), "a studio path reached the client");
});

test("a files page says nothing in its title, to anybody", { skip }, async () => {
  // The same title as every other page in the client world: it reveals neither
  // the work nor which page you are on, and a refusal carries it too.
  for (const cookie of [clientA, clientB, undefined]) {
    const response = await get(`/workrooms/${roomA}/files`, cookie);
    assert.match(response.body, /<title>Workroom — Yiddi Weller<\/title>/, String(cookie));
  }
  const other = await get(`/workrooms/${roomB}/files`, clientA);
  assert.match(other.body, /<title>Workroom — Yiddi Weller<\/title>/);
});

test("a download is authorized, and every refusal looks the same", { skip }, async () => {
  const own = await get(`/workrooms/${roomA}/files/${fileA}/download`, clientA);
  assert.equal(own.status, 302, "a member could not download their own file");
  assert.ok(own.location.length > 0);
  // The signed URL goes in a header, never into a page.
  assert.ok(!own.body.includes("http"), "a signed URL reached the body");

  const refusals = [
    [`/workrooms/${roomA}/files/${fileB}/download`, clientA, "another workroom's file"],
    [`/workrooms/${roomB}/files/${fileA}/download`, clientB, "another workroom's file, reversed"],
    [`/workrooms/${roomA}/files/${internalA}/download`, clientA, "an internal file"],
    [`/workrooms/${roomA}/files/00000000000000000000000000/download`, clientA, "a file that never existed"],
    [`/workrooms/${roomA}/files/not-a-public-id/download`, clientA, "a malformed id"],
  ] as const;

  for (const [path, cookie, what] of refusals) {
    const response = await get(path, cookie);
    assert.equal(response.status, 404, what);
    assert.equal(response.body.length, 0, `${what} answered with a body to compare`);
    assert.equal(response.location, "", `${what} leaked a location`);
  }
});

test("an anonymous request learns nothing before it is sent to sign in", { skip }, async () => {
  for (const path of [`/workrooms/${roomA}/files`, `/workrooms/${roomA}/files/${fileA}/download`]) {
    const response = await get(path, undefined);
    assert.ok([302, 307].includes(response.status), `${path} answered ${response.status}`);
    assert.deepEqual(leaks(response.body, ["Alder", "Ana Alder"]), [], path);
  }
});

test("a studio session is not a way into a client's files", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, staff);
  assert.ok([302, 307].includes(page.status));

  const download = await get(`/workrooms/${roomA}/files/${fileA}/download`, staff);
  assert.ok([302, 307].includes(download.status));
  // Not a signed storage URL: a redirect to the client sign-in page.
  assert.ok(!download.location.includes("X-Amz-Signature"), "staff were handed a client's file");
});

test("a client session is not a way into the studio's files", { skip }, async () => {
  const response = await get(`/studio/workrooms/${roomA}/files`, clientA);
  assert.ok([302, 307, 404].includes(response.status));
  assert.deepEqual(leaks(response.body), []);
});

test("a private file response is never stored by anything in between", { skip }, async () => {
  for (const path of [`/workrooms/${roomA}/files`, `/workrooms/${roomA}/files/${fileA}/download`]) {
    const response = await get(path, clientA);
    assert.match(response.cacheControl, /no-store/, path);
    assert.match(response.cacheControl, /private/, path);
  }
});

test("public pages and robots are untouched by any of it", { skip }, async () => {
  for (const path of ["/", "/work", "/contact"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.ok(!response.cacheControl.includes("no-store"), `${path} lost its caching`);
    assert.ok(!response.body.includes("/files"), `${path} links into a private area`);
  }

  const robots = await get("/robots.txt");
  assert.match(robots.body, /Disallow: \/workrooms$/m);

  const sitemap = await get("/sitemap.xml");
  assert.ok(!sitemap.body.includes("files"), "a private path reached the sitemap");
});

/* ------------------------------------------- the client's way into Files */

/**
 * Found by hand on beta: a file was shared, the client's Workroom showed it,
 * and the staff preview did not — because the two pages each held their own
 * copy of the same markup and only one of them was updated. Nothing failed.
 * The preview simply showed an older product, which is the worst way for a
 * verification surface to be wrong.
 *
 * These are the tests that would have caught it.
 */

/** The headings a client sees, in order, from either surface. */
function sections(body: string): string[] {
  return [...body.matchAll(/<h2[^>]*>([^<]+)<\/h2>/g)].map((match) => match[1]!.trim());
}

test("a client with a shared file is offered a way to reach it", { skip }, async () => {
  const overview = await get(`/workrooms/${roomA}`, clientA);
  assert.equal(overview.status, 200);

  assert.ok(sections(overview.body).includes("Files"), "no Files section on the overview");
  assert.match(
    overview.body,
    new RegExp(`href="/workrooms/${roomA}/files"`),
    "no link to the files page",
  );

  // And the link goes somewhere that works, rather than merely existing.
  const files = await get(`/workrooms/${roomA}/files`, clientA);
  assert.equal(files.status, 200);
});

test("the staff preview shows the same sections the client is shown", { skip }, async () => {
  const client = await get(`/workrooms/${roomA}`, clientA);
  const preview = await get(`/studio/workrooms/${studioRoomA}/preview`, staff);
  assert.equal(preview.status, 200);

  // The exact claim the preview page makes about itself, asserted rather than
  // trusted. Two surfaces rendering one component cannot disagree; two copies
  // of the same markup can, and did.
  assert.deepEqual(
    sections(preview.body),
    sections(client.body),
    "the preview and the client's page no longer show the same sections",
  );
  assert.ok(sections(preview.body).includes("Files"), "the preview lost the Files section");
});

test("the preview shows shared files and no others", { skip }, async () => {
  const preview = await get(`/studio/workrooms/${studioRoomA}/preview`, staff);

  // A preview that showed internal files would be worse than no preview: it
  // would say a client can see something they cannot.
  //
  // Keyed to the **opaque public ids** the page links to, not to display names.
  // It was written against two files renamed by hand during an earlier session
  // — "shared deck" and "internal deck" — which no seed creates, so it could
  // never pass from a clean environment. The ids come from the same seed as
  // every other assertion here and cannot drift from it.
  assert.ok(preview.body.includes(fileA!), "the preview hid a shared file");
  assert.ok(!preview.body.includes(internalA!), "the preview showed an internal file");
  assert.deepEqual(leaks(preview.body), [], "an internal field reached the preview");
});

test("a client with nothing shared is offered nothing to open", { skip }, async () => {
  // Workroom B's files are shared, so this uses the one surface that is
  // guaranteed empty for A: another tenant's room, which A cannot reach at all.
  const refused = await get(`/workrooms/${roomB}`, clientA);
  assert.equal(refused.status, 404);
  assert.ok(!refused.body.includes("/files"), "a refusal advertised a files page");
});

/* ---------------------------------------------------------- image previews */

/**
 * A shared image should look like the work it is, and everything else should
 * stay a row. These read the markup, because the whole gap this closed was that
 * the preview existed in storage and nothing rendered it.
 */

test("a shared image is shown, and the signed URL is not in the page", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, clientA);
  assert.equal(page.status, 200);

  // Our own route, never a storage address.
  const src = `/workrooms/${roomA}/files/${imageA}/preview`;
  assert.ok(page.body.includes(`src="${src}"`), "the image is not rendered");
  // The thumbnail is a link to the viewer now, so its accessible name says
  // where it goes rather than describing the picture — which is what a link's
  // name is for. The full viewer, where the image is the content, uses the
  // file's name as its alt instead.
  assert.match(page.body, /alt="Open [^"]+"/, "the thumbnail link has no meaningful name");

  // The things a signed URL would bring with it, none of which may appear.
  assert.ok(!page.body.includes("X-Amz-Signature"), "a signed URL reached the page");
  assert.ok(!page.body.includes("X-Amz-Credential"), "a credential reached the page");
  // The same regex covers a preview key, which is the file's key plus
  // `/preview` — so there is no separate check to write, and no way to write
  // one that would not also match the legitimate route above.
  assert.ok(!/\bw\/[0-9a-f-]{36}\/f\//.test(page.body), "a storage key reached the page");
});

test("only decodable images are shown; everything else stays a row", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, clientA);

  // An SVG is stored and downloadable and never rendered — decoding one runs
  // its contents, and serving it inline from our origin is stored XSS.
  assert.ok(
    !page.body.includes(`/files/${svgA}/preview`),
    "an SVG was given a preview",
  );
  assert.ok(page.body.includes(`/files/${svgA}/download`), "the SVG lost its download row");

  // And the non-image seeded alongside it.
  assert.ok(!page.body.includes(`/files/${fileA}/preview`), "a PDF was given a preview");
  assert.ok(page.body.includes(`/files/${fileA}/download`));
});

test("a preview is authorized exactly as its file is", { skip }, async () => {
  const own = await get(`/workrooms/${roomA}/files/${imageA}/preview`, clientA);
  assert.equal(own.status, 302, "a member could not see their own image");
  assert.ok(own.location.length > 0);
  assert.equal(own.body.length, 0);

  const refusals = [
    [`/workrooms/${roomA}/files/${internalImageA}/preview`, clientA, "an internal image"],
    [`/workrooms/${roomA}/files/${svgA}/preview`, clientA, "an SVG, which has no preview object"],
    [`/workrooms/${roomB}/files/${imageA}/preview`, clientB, "another workroom's image"],
    [`/workrooms/${roomA}/files/00000000000000000000000000/preview`, clientA, "one that never existed"],
    [`/workrooms/${roomA}/files/${imageA}/preview`, undefined, "nobody"],
  ] as const;

  for (const [path, cookie, what] of refusals) {
    const response = await get(path, cookie);
    if (cookie === undefined) {
      assert.ok([302, 307].includes(response.status), what);
      assert.ok(!response.location.includes("X-Amz-Signature"), `${what} was handed a signed URL`);
    } else {
      assert.equal(response.status, 404, what);
      assert.equal(response.body.length, 0, `${what} answered with a body to compare`);
      assert.equal(response.location, "", `${what} leaked a location`);
    }
  }
});

test("a preview response is never stored by anything in between", { skip }, async () => {
  const response = await get(`/workrooms/${roomA}/files/${imageA}/preview`, clientA);
  assert.match(response.cacheControl, /no-store/);
  assert.match(response.cacheControl, /private/);
});

test("staff see previews, internal ones included", { skip }, async () => {
  const page = await get(`/studio/workrooms/${studioRoomA}/files`, staff);
  assert.equal(page.status, 200);

  // Recognising an internal image at a glance is most of why this is here.
  assert.ok(
    page.body.includes(`/studio/workrooms/${studioRoomA}/files/${internalImageA}/preview`),
    "staff cannot see an internal image",
  );

  const internal = await get(`/studio/workrooms/${studioRoomA}/files/${internalImageA}/preview`, staff);
  assert.equal(internal.status, 302);

  // And the staff route is not a way in for a client session.
  const asClient = await get(`/studio/workrooms/${studioRoomA}/files/${internalImageA}/preview`, clientA);
  assert.ok([302, 307, 404].includes(asClient.status));
  assert.ok(!asClient.location.includes("X-Amz-Signature"), "a client was handed an internal image");
});

test("the overview keeps its hint restrained", { skip }, async () => {
  const overview = await get(`/workrooms/${roomA}`, clientA);
  const files = await get(`/workrooms/${roomA}/files`, clientA);

  // A chip on the overview, a framed preview on the Files page.
  //
  // Deliberately not "at least one": the Overview summarises the three most
  // recent files, and whether any of those happens to be an image depends on
  // what was uploaded last. Three PDFs in a row mean no chips, and that is the
  // Overview being a summary rather than a gallery. What must hold is the
  // ceiling — if it ever grows as many images as the library, this notices.
  const count = (body: string) => [...body.matchAll(/\/preview"/g)].length;
  assert.ok(
    count(overview.body) <= 3,
    "the overview is showing more than the three files it summarises",
  );
  assert.ok(count(files.body) >= count(overview.body), "the Files page shows fewer images");
});

/* ------------------------------------------------- the agency file viewer */

/**
 * The pattern these assert is the one every professional delivery tool follows:
 * store almost anything, render what a browser can render safely, and always
 * keep a separate download of the original. The interesting half is the second
 * clause — what must **not** render — because that is where a viewer becomes an
 * execution surface.
 */

test("every viewable kind opens, and nothing else does", { skip }, async () => {
  for (const [id, element] of [
    [imageA, /<img[^>]+class="[^"]*viewerImage/],
    [pdfA, /<iframe[^>]+class="[^"]*viewerFrame/],
    [videoA, /<video[^>]+controls/],
    [audioA, /<audio[^>]+controls/],
  ] as const) {
    const page = await get(`/workrooms/${roomA}/files/${id}`, clientA);
    assert.equal(page.status, 200, String(id));
    assert.match(page.body, element, String(id));

    // The source is one of our routes. A signed URL never travels in markup.
    assert.ok(
      page.body.includes(`/workrooms/${roomA}/files/${id}/view`),
      `${id} did not use the authorized route`,
    );
    assert.ok(!page.body.includes("X-Amz-Signature"), `${id} leaked a signed URL`);

    // Download original is offered on every one of them.
    assert.ok(page.body.includes(`/files/${id}/download`), `${id} lost its download`);
  }
});

test("an unviewable file is a polished card, not an empty viewer", { skip }, async () => {
  for (const id of [svgA, sourceA]) {
    const page = await get(`/workrooms/${roomA}/files/${id}`, clientA);
    assert.equal(page.status, 200, String(id));

    assert.match(page.body, /No preview for this kind of file\./, String(id));
    assert.ok(page.body.includes(`/files/${id}/download`), `${id} lost its download`);

    // Nothing that could render or execute it.
    for (const element of ["<iframe", "<object", "<embed", "viewerImage", "<video", "<audio"]) {
      assert.ok(!page.body.includes(element), `${id} was given ${element}`);
    }
  }
});

test("an SVG is never served inline, by any route", { skip }, async () => {
  // The route refuses from the stored content type, so there is nothing a
  // request can say to obtain an inline disposition for one.
  const inline = await get(`/workrooms/${roomA}/files/${svgA}/view`, clientA);
  assert.equal(inline.status, 404, "an SVG was served inline");
  assert.equal(inline.location, "");

  // It is still perfectly downloadable, as an attachment.
  const download = await get(`/workrooms/${roomA}/files/${svgA}/download`, clientA);
  assert.equal(download.status, 302);
  assert.match(
    decodeURIComponent(download.location),
    /response-content-disposition=attachment/,
    "an SVG download was not forced to an attachment",
  );
});

test("inline is only ever offered to approved kinds, and download always forces attachment", { skip }, async () => {
  for (const id of [imageA, pdfA, videoA, audioA] as const) {
    const view = await get(`/workrooms/${roomA}/files/${id}/view`, clientA);
    assert.equal(view.status, 302, String(id));
    const location = decodeURIComponent(view.location);
    assert.match(location, /response-content-disposition=inline/, `${id} was not inline`);

    const download = await get(`/workrooms/${roomA}/files/${id}/download`, clientA);
    assert.match(
      decodeURIComponent(download.location),
      /response-content-disposition=attachment/,
      `${id} download was not an attachment`,
    );
  }

  // And the source formats cannot reach the inline path at all.
  for (const id of [svgA, sourceA] as const) {
    assert.equal((await get(`/workrooms/${roomA}/files/${id}/view`, clientA)).status, 404, String(id));
  }
});

test("the viewer and its bytes obey the same rules as the download", { skip }, async () => {
  const refusals = [
    [`/workrooms/${roomA}/files/${internalImageA}`, clientA, "an internal file's page"],
    [`/workrooms/${roomA}/files/${internalImageA}/view`, clientA, "an internal file's bytes"],
    [`/workrooms/${roomA}/files/${archivedA}`, clientA, "an archived file's page"],
    [`/workrooms/${roomA}/files/${archivedA}/view`, clientA, "an archived file's bytes"],
    [`/workrooms/${roomB}/files/${pdfA}`, clientB, "another workroom's page"],
    [`/workrooms/${roomB}/files/${pdfA}/view`, clientB, "another workroom's bytes"],
    [`/workrooms/${roomA}/files/00000000000000000000000000/view`, clientA, "one that never existed"],
  ] as const;

  for (const [path, cookie, what] of refusals) {
    const response = await get(path, cookie);
    assert.equal(response.status, 404, what);
    assert.equal(response.location, "", `${what} leaked a location`);
    assert.deepEqual(leaks(response.body), [], what);
  }

  // Anonymous is sent to sign in, and handed no bytes on the way.
  const anonymous = await get(`/workrooms/${roomA}/files/${pdfA}/view`, undefined);
  assert.ok([302, 307].includes(anonymous.status));
  assert.ok(!anonymous.location.includes("X-Amz-Signature"));

  // A Studio session is not a client session.
  const asStaff = await get(`/workrooms/${roomA}/files/${pdfA}/view`, staff);
  assert.ok([302, 307].includes(asStaff.status));
  assert.ok(!asStaff.location.includes("X-Amz-Signature"));
});

test("a viewer page carries nothing internal and no storage address", { skip }, async () => {
  for (const id of [imageA, pdfA, videoA, audioA, svgA, sourceA] as const) {
    const page = await get(`/workrooms/${roomA}/files/${id}`, clientA);

    assert.deepEqual(leaks(page.body), [], String(id));
    assert.ok(!/\bw\/[0-9a-f-]{36}\/f\//.test(page.body), `${id} leaked a storage key`);
    assert.ok(!page.body.includes("X-Amz-Credential"), `${id} leaked a credential`);
    assert.ok(!page.body.includes("pending/"), `${id} leaked a pending key`);
    assert.ok(!page.body.includes("Birch"), `${id} leaked another tenant`);
    // The bucket endpoint itself, which is the host of every signed URL.
    assert.ok(!page.body.includes("127.0.0.1:"), `${id} leaked the bucket endpoint`);

    assert.match(page.body, /<title>Workroom — Yiddi Weller<\/title>/, String(id));
    assert.match(page.cacheControl, /private/, String(id));
    assert.match(page.cacheControl, /no-store/, String(id));
  }
});

test("media does not start on its own", { skip }, async () => {
  for (const id of [videoA, audioA] as const) {
    const page = await get(`/workrooms/${roomA}/files/${id}`, clientA);
    assert.ok(!page.body.includes("autoplay"), `${id} autoplays`);
    assert.ok(page.body.includes('preload="metadata"'), `${id} preloads more than it should`);
    assert.ok(page.body.includes("controls"), `${id} has no controls`);
  }
});

test("staff open the same viewer, internal files included", { skip }, async () => {
  const page = await get(`/studio/workrooms/${studioRoomA}/files/${internalImageA}`, staff);
  assert.equal(page.status, 200, "staff cannot open an internal file");
  assert.match(page.body, /viewerImage/);
  assert.ok(page.body.includes(`/studio/workrooms/${studioRoomA}/files/${internalImageA}/view`));
  assert.ok(!page.body.includes("X-Amz-Signature"), "the staff viewer leaked a signed URL");

  // The staff route is not a way in for a client session, and vice versa.
  const asClient = await get(`/studio/workrooms/${studioRoomA}/files/${internalImageA}/view`, clientA);
  assert.ok([302, 307, 404].includes(asClient.status));
  assert.ok(!asClient.location.includes("X-Amz-Signature"), "a client reached an internal file");
});

test("the files list offers View where there is one, and Download everywhere", { skip }, async () => {
  const page = await get(`/workrooms/${roomA}/files`, clientA);
  assert.equal(page.status, 200);

  for (const id of [imageA, pdfA, videoA, audioA] as const) {
    assert.ok(page.body.includes(`href="/workrooms/${roomA}/files/${id}"`), `${id} has no View`);
  }
  for (const id of [svgA, sourceA] as const) {
    assert.ok(
      !page.body.includes(`href="/workrooms/${roomA}/files/${id}"`),
      `${id} was offered a View it cannot honour`,
    );
  }
  // Download on every one of them, viewable or not.
  for (const id of [imageA, pdfA, videoA, audioA, svgA, sourceA] as const) {
    assert.ok(page.body.includes(`/files/${id}/download`), `${id} lost its download`);
  }
});
