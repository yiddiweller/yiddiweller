import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { renderNotification, SUBJECTS } from "../lib/notifications/render.ts";

/**
 * Stage G1: the two notification messages. A subject names nothing; a body
 * names the Presentation and its version (and, for the studio, the client),
 * escaped; neither ever carries feedback, an anchor, a file or a signed
 * address — only the one app link it was handed.
 */

const CLIENT_URL = "https://yiddiweller.com/workrooms/k3m9q2w7x4v8b5n1c6z0p3r8t2/presentations/h7j2k9m4n8q1w5e3r6t0y2u4i7/revisions/2";
const STUDIO_URL = "https://studio.yiddiweller.com/workrooms/01a0ef10-0000-7000-8000-0000000000c3/presentations/01a0ef10-0000-7000-8000-0000000000e5/revisions/2?note=1";

const FEEDBACK = "MARKER-FEEDBACK-BODY: please make the logo bigger";
const ANCHOR = '{"kind":"point","x":0.25,"y":0.75}';

const requested = (title = "Brand Direction") =>
  renderNotification("review.requested", { presentationTitle: title, version: 2, url: CLIENT_URL });
const received = (title = "Brand Direction", clientName: string | null = "Ana Alder") =>
  renderNotification("review.received", { presentationTitle: title, version: 2, clientName, url: STUDIO_URL });

/** Every href and src in an HTML message. */
const links = (html: string) => [...html.matchAll(/\b(?:href|src)="([^"]*)"/g)].map((m) => m[1]!);

test("subjects are exactly the approved words and name nothing", () => {
  assert.equal(requested().subject, "Your thoughts are requested — Yiddi Weller");
  assert.equal(received().subject, "New feedback in a workroom");
  assert.deepEqual(SUBJECTS, {
    "review.requested": "Your thoughts are requested — Yiddi Weller",
    "review.received": "New feedback in a workroom",
  });
  for (const mail of [requested("Secret Rebrand"), received("Secret Rebrand", "Ana Alder")]) {
    assert.doesNotMatch(mail.subject, /Secret Rebrand|Ana|Alder|Version|\r|\n/);
  }
});

test("a client's request names the Presentation and version in the body, and links to that exact version", () => {
  const mail = requested();
  assert.match(mail.html, /Brand Direction/);
  assert.match(mail.html, /Version&nbsp;2/);
  assert.match(mail.text, /Brand Direction, Version 2\./);
  assert.match(mail.text, new RegExp(CLIENT_URL.replace(/[.?]/g, "\\$&")));
  assert.match(mail.html, /Open the presentation/);
  // The reply-in-the-workroom line, in both forms.
  assert.match(mail.html, /A reply to this email reaches the studio, but it is not added to the feedback\./);
  assert.match(mail.text, /A reply to this email reaches the\s+studio, but it is not added to the feedback\./);
});

test("the studio's notice names the client, the Presentation and the version, and links to the note", () => {
  const mail = received();
  assert.match(mail.html, /Ana Alder left feedback on/);
  assert.match(mail.html, /Version&nbsp;2/);
  assert.match(mail.text, /Ana Alder left feedback on Brand Direction, Version 2\./);
  assert.match(mail.text, /\?note=1/);
  assert.match(mail.html, /Open in Studio/);
  assert.match(mail.html, /What they wrote is in Studio, not in this email\./);
  // A nameless round says "A client", never "null".
  for (const name of [null, "", "   "]) {
    const anon = received("Brand Direction", name);
    assert.match(anon.text, /^A client left feedback/m, String(name));
    assert.doesNotMatch(anon.text + anon.html, /null|undefined/);
  }
});

test("the only link in either message is the one it was handed — no file, no signed address, no pixel", () => {
  for (const [mail, url] of [[requested(), CLIENT_URL], [received(), STUDIO_URL]] as const) {
    const found = links(mail.html).filter((href) => !href.startsWith("https://yiddiweller.com") || href === url.replace(/&/g, "&amp;"));
    // The CTA, plus the footer's mark and home link that every client mail carries.
    assert.ok(links(mail.html).includes(url.replace(/&/g, "&amp;")), "the CTA is not the link handed in");
    for (const href of links(mail.html)) {
      assert.ok(
        href === url.replace(/&/g, "&amp;") || href === "https://yiddiweller.com" || href === "https://yiddiweller.com/email-mark.png",
        `an unexpected link: ${href}`,
      );
    }
    assert.ok(found.length >= 1);
    const all = `${mail.subject}\n${mail.html}\n${mail.text}`;
    assert.doesNotMatch(all, /X-Amz-|Signature=|\/original\b|\/files\/|\/view\b|\/download\b|bucket|presign/i);
    assert.doesNotMatch(mail.html, /<img[^>]*(width="1"|height="1")/i, "a tracking pixel");
    assert.doesNotMatch(mail.html, /<script|onload=|onerror=|javascript:/i);
  }
});

test("feedback, anchors and identifiers never appear, whatever the view is handed", () => {
  // The views have no field for any of it, and smuggling it in does nothing.
  const smuggled = renderNotification("review.received", {
    presentationTitle: "Brand Direction",
    version: 2,
    clientName: "Ana Alder",
    url: STUDIO_URL,
    ...({ body: FEEDBACK, anchor: ANCHOR, email: "ana@example.com" } as object),
  });
  const all = `${smuggled.subject}\n${smuggled.html}\n${smuggled.text}`;
  assert.doesNotMatch(all, /MARKER-FEEDBACK-BODY|logo bigger|"kind":"point"|ana@example\.com/);
  // No database identifier outside the link itself.
  const outsideLink = all.split(STUDIO_URL).join("").split(STUDIO_URL.replace(/&/g, "&amp;")).join("");
  assert.doesNotMatch(outsideLink, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("hostile titles and names are escaped in HTML and flattened to one line in text", () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)> "quoted" & co';
  const name = '"><a href="https://evil.example">click</a>\r\nBcc: victim@example.com';
  for (const mail of [requested(evil), received(evil, name)]) {
    assert.doesNotMatch(mail.html, /<script>|<img src=x|<a href="https:\/\/evil/);
    assert.doesNotMatch(mail.html, /<[^>]*\bon[a-z]+=/i, "a real tag carries an event handler");
    assert.match(mail.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(mail.html, /&quot;quoted&quot; &amp; co/);
    assert.doesNotMatch(mail.subject, /script|evil|Bcc/);
    assert.ok(!links(mail.html).some((href) => href.includes("evil.example")), "a name became a link");
  }
  const text = received(evil, name).text;
  assert.doesNotMatch(text, /\r/);
  assert.doesNotMatch(text, /\nBcc:/, "a name broke onto its own line");
});

test("both messages have a readable plain-text part, not just HTML", () => {
  for (const mail of [requested(), received()]) {
    assert.ok(mail.text.length > 80);
    assert.doesNotMatch(mail.text, /<[a-z/][^>]*>/i, "markup in the text part");
    assert.match(mail.text, /^YIDDI WELLER/);
  }
});

test("a link that is not an absolute http(s) URL, or a version that is not a version, is refused", () => {
  for (const url of ["/workrooms/x", "javascript:alert(1)", "data:text/html,x", "ftp://example.com/x", "https://user:pass@example.com/x", ""]) {
    assert.throws(() => renderNotification("review.requested", { presentationTitle: "T", version: 1, url }), url);
  }
  for (const version of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => renderNotification("review.requested", { presentationTitle: "T", version, url: CLIENT_URL }), String(version));
  }
  assert.throws(() => renderNotification("review.replied" as never, { presentationTitle: "T", version: 1, url: CLIENT_URL } as never));
});

test("the renderer is pure: no provider, no database, no clock", () => {
  const source = readFileSync("lib/notifications/render.ts", "utf8");
  assert.doesNotMatch(source, /from "resend"|lib\/db|\.\.\/db\/|new Date|Date\.now|fetch\(|process\.env/);
});
