import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * Confirmations are the studio's, not the browser's.
 *
 * Two halves, and they check different things. The **source scan** needs
 * nothing running and is the guard that matters most: a browser's own
 * `confirm()` is one line of code away at any moment, and once one is back the
 * product has two confirmation designs. The **rendered markup** checks that the
 * dialog a page ships actually says the words it should, with the semantics
 * that make it a dialog rather than a div.
 *
 * What neither can check is behaviour in a browser — opening, Escape, focus
 * return, double submission. This repository has no DOM test runner and adding
 * one for this would be a larger change than the thing it verifies, so those
 * are driven against the running deployment the same way the responsive and
 * accessibility sweeps have been since Build 002.
 */

/* --------------------------------------------------------- the source scan */

const ROOTS = ["app", "components", "lib"];

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sources(path, found);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

test("no browser-native dialog survives anywhere a person can reach", () => {
  // `window.x` and the bare call, because a bare `confirm(…)` resolves to the
  // same global and reads as ordinary code. Deliberately not matching the word
  // `confirm` alone: it is a prop name on every action in Studio.
  const banned = [
    /\bwindow\s*\.\s*(confirm|alert|prompt)\s*\(/,
    /(^|[^.\w])(confirm|alert|prompt)\s*\(/m,
  ];

  const offenders: string[] = [];

  for (const root of ROOTS) {
    for (const path of sources(root)) {
      const body = readFileSync(path, "utf8");

      for (const line of body.split("\n")) {
        // Comments and type positions are prose, not calls.
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (!code.trim()) continue;
        // `confirm={{ … }}` and `confirm?: Confirm` are the prop, not a call.
        if (/confirm\s*[?:=]/.test(code)) continue;

        if (banned.some((pattern) => pattern.test(code))) {
          offenders.push(`${path}: ${line.trim()}`);
        }
      }
    }
  }

  assert.deepEqual(offenders, [], "a browser-native dialog is back");
});

test("every confirmation names its action rather than asking whether you are sure", () => {
  const copy: string[] = [];

  for (const root of ROOTS) {
    for (const path of sources(root)) {
      const body = readFileSync(path, "utf8");
      for (const match of body.matchAll(/title:\s*(`[^`]*`|"[^"]*")/g)) {
        if (/Archive|Remove|Revoke|Publish|Unpublish|Withdraw|Stop sharing|Switch off|Take away/.test(match[1]!)) {
          copy.push(match[1]!);
        }
      }
      // The words a browser would have used, and the reason this exists.
      for (const lazy of ["Are you sure", "Are you certain", ">OK<", "action: \"OK\"", "action: \"Yes\""]) {
        assert.ok(!body.includes(lazy), `${path} says ${JSON.stringify(lazy)}`);
      }
    }
  }

  assert.ok(copy.length >= 15, `expected the confirmations to be action-titled, found ${copy.length}`);
  for (const title of copy) {
    assert.ok(title.trimEnd().endsWith("?`") || title.trimEnd().endsWith('?"'), `${title} is not a question`);
  }
});

/* ------------------------------------------------------- the rendered markup */

const base = process.env.STUDIO_BASE_URL;
const staff = process.env.STUDIO_OWNER_COOKIE;
const room = process.env.STUDIO_WORKROOM_A_ID;
const presentation = process.env.PRESENTATION_A_ID;

const configured = Boolean(base && staff && room && presentation);
const skip = configured
  ? false
  : "set STUDIO_BASE_URL, STUDIO_OWNER_COOKIE, STUDIO_WORKROOM_A_ID and PRESENTATION_A_ID";

async function page(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { headers: { cookie: staff! } });
  assert.equal(response.status, 200, path);
  return response.text();
}

/** Every confirmation a page ships, read out of its markup. */
function dialogs(body: string): { title: string; note: string; action: string }[] {
  const found: { title: string; note: string; action: string }[] = [];

  for (const match of body.matchAll(/<dialog\b[^>]*aria-labelledby="([^"]+)-title"[^>]*>([\s\S]*?)<\/dialog>/g)) {
    const inner = match[2]!;
    const title = /dialogTitle[^>]*>([^<]*)/.exec(inner)?.[1] ?? "";
    const note = /dialogNote[^>]*>([^<]*)/.exec(inner)?.[1] ?? "";
    // The action button is the submit one; Cancel is the quiet button.
    const action = /<button type="submit"[^>]*>([^<]*)/.exec(inner)?.[1] ?? "";
    // Only confirmations, not the form dialogs that share the same shell.
    if (title.trim().endsWith("?")) found.push({ title, note, action });
  }

  return found;
}

test("a file's consequential actions each ship a dialog that says what happens", { skip }, async () => {
  const body = await page(`/studio/workrooms/${room}/files`);
  const found = dialogs(body);

  const sharing = found.find((entry) => entry.title === "Stop sharing this file?");
  assert.ok(sharing, "no confirmation for un-sharing a file");
  assert.equal(sharing.note, "The client will no longer see it in Files.");
  assert.equal(sharing.action, "Stop sharing");

  const archiving = found.find((entry) => entry.title === "Archive this file?");
  assert.ok(archiving, "no confirmation for archiving a file");
  assert.equal(archiving.note, "It leaves the workroom and stays in the record.");
  assert.equal(archiving.action, "Archive");

  // Sharing is the everyday action this page exists for, it is reversible in
  // one click, and its result is visible in the row. It asks nothing.
  assert.ok(!found.some((entry) => entry.title.startsWith("Share")), "sharing grew a confirmation");
});

test("publishing states the number of files it will hand over", { skip }, async () => {
  const body = await page(`/studio/workrooms/${room}/presentations/${presentation}`);
  const found = dialogs(body);

  const publish = found.find((entry) => entry.title.startsWith("Publish"));
  assert.ok(publish, "no confirmation on publish");
  assert.equal(publish.action, "Publish");
  assert.match(
    publish.note,
    /(One file|\d+ files) will also be shared with the client|will see this instead of the current version|can open it from that moment/,
    `publish said: ${publish.note}`,
  );

  const withdraw = found.find((entry) => entry.title === "Withdraw this presentation?");
  assert.ok(withdraw, "no confirmation on withdraw");
  assert.equal(withdraw.action, "Withdraw");
});

test("a confirmation is a dialog, semantically, and Cancel holds the focus", { skip }, async () => {
  const body = await page(`/studio/workrooms/${room}/files`);

  // Labelled and described by its own title and note, so a screen reader
  // announces the consequence rather than just the buttons.
  const described = [...body.matchAll(/<dialog\b[^>]*aria-labelledby="([^"]+)-title"[^>]*aria-describedby="\1-note"/g)];
  assert.ok(described.length > 0, "no confirmation is described by its own message");

  // Cancel takes focus, so the keyboard's first Enter is the safe one.
  assert.match(body, /<button type="button"[^>]*autofocus="">Cancel<\/button>/);

  // And the trigger cannot fire the action on its own: where a confirmation
  // exists the trigger is an ordinary button, and the only submit button is
  // the one inside the dialog.
  assert.ok(!/<button type="submit"[^>]*>Archive<\/button>\s*<dialog/.test(body));
});

test("the client's world has no confirmations to replace", { skip }, async () => {
  // Nothing a client can do is destructive: there is no archive, no revoke and
  // no publish out there. Worth asserting rather than assuming, because the
  // day one appears it should arrive with a dialog like everything else.
  for (const path of ["components/workrooms", "app/workrooms"]) {
    for (const file of sources(path)) {
      const body = readFileSync(file, "utf8");
      assert.ok(!/\bwindow\s*\.\s*(confirm|alert|prompt)\s*\(/.test(body), `${file} asks the browser`);
    }
  }
});
