import { type WorkroomFileRow } from "../db/files.ts";
import { type FileKind, type ViewerKind } from "../storage/policy.ts";
import {
  toPresentedFile,
  withPaths,
  type ClientFile,
  type FileBase,
  type PresentedFile,
} from "./delivery-view.ts";

/**
 * The only shape of a Presentation that reaches a client surface.
 *
 * **A whitelist, not a filter**, exactly as `view.ts` and `delivery-view.ts`
 * are. A database row is never spread into a client component, and adding a
 * field to a Presentation page means adding it here first, deliberately, in
 * review.
 *
 * What is deliberately absent, and never fetched on a client request: every
 * internal id — the Presentation's own uuid, every item's uuid, every
 * Revision's uuid, every File's uuid — `created_by`, `updated_by`,
 * `published_by`, `version`, `content_hash`, `storage_key`, `preview_key`,
 * `storage_etag`, `original_filename`, the raw `content_type`, the raw byte
 * count, every draft item of a published Presentation, every `internal` file,
 * every `notes` field anywhere, and every other Workroom's anything.
 *
 * **Items are keyed by `position`, not by id.** A client needs something stable
 * to render a list against, and a position is a fact about the sequence rather
 * than a handle on a row. It is also what makes the frozen snapshot renderable
 * years later without reaching for a table.
 *
 * ## What is stored, and what is assembled
 *
 * A published Revision freezes `PresentationContent` — title, intro, items —
 * into `presentation_revisions.snapshot`, and the content hash is taken over
 * exactly that. Everything else in `ClientPresentation` is assembled at read
 * time from immutable columns: which revision number this is, when it was
 * published, and the list of revisions the client may open.
 *
 * That split is deliberate. If `publishedAt` were inside the hashed content,
 * two publications of identical work would hash differently and the hash would
 * stop answering the only question it exists to answer — *is this the same work
 * the client saw?*
 */

/**
 * One block of a Presentation **as content** — no routes, nothing about who is
 * looking. This is what a Revision freezes and what the hash covers.
 */
export type PresentedItem =
  | {
      position: number;
      kind: "note";
      /** An optional heading above the words. */
      caption: string | null;
      body: string;
    }
  | {
      position: number;
      kind: "file";
      /** The line under the work. Optional; most files have one. */
      caption: string | null;
      file: PresentedFile;
    };

/** The same block, rendered — the file now carrying a surface's own routes. */
export type ClientRevisionItem =
  | { position: number; kind: "note"; caption: string | null; body: string }
  | { position: number; kind: "file"; caption: string | null; file: ClientFile };

/** Exactly what is frozen at publication, and exactly what the hash covers. */
export type PresentationContent = {
  title: string;
  intro: string;
  items: PresentedItem[];
};

/** One entry in `Previous versions`: which, and when. Never what changed. */
export type ClientRevisionRef = {
  number: number;
  publishedAt: string;
  current: boolean;
};

export type ClientPresentation = {
  /** The opaque public id. The only identifier a client ever receives. */
  id: string;
  title: string;
  intro: string;
  items: ClientRevisionItem[];
  /**
   * Null for a draft the studio is previewing. A client never receives one:
   * every client-facing read goes through a published Revision.
   */
  publishedAt: string | null;
  /** Null for a draft. `1`, `2`, `3` … for anything a client can open. */
  revision: number | null;
  /**
   * Two facts and a flag per published Revision — deliberately nothing about
   * what changed. A client reading a changelog of the studio's second thoughts
   * is not the product.
   */
  revisions: ClientRevisionRef[];
};

/** What a draft item looks like before projection. */
export type PresentableItem = {
  position: number;
  kind: "file" | "note";
  caption: string | null;
  body: string | null;
  /** Present for `file` items. The row is projected, never passed through. */
  file?: WorkroomFileRow | null;
  /** The name the client was shown. A later rename never rewrites history. */
  displayNameSnapshot?: string | null;
};

/**
 * One item, made safe.
 *
 * A `file` item whose File cannot be resolved is dropped by the caller rather
 * than rendered as a gap — see `toPresentationContent`.
 */
function toPresented(item: PresentableItem): PresentedItem | null {
  if (item.kind === "note") {
    if (item.body === null) return null;
    return {
      position: item.position,
      kind: "note",
      caption: item.caption,
      body: item.body,
    };
  }

  if (!item.file) return null;

  const file = toPresentedFile(item.file);

  return {
    position: item.position,
    kind: "file",
    caption: item.caption,
    // The snapshot wins where there is one. What the client read at
    // publication is the record, and renaming the File afterwards must not
    // quietly rewrite a Revision somebody may have approved.
    file: item.displayNameSnapshot ? { ...file, name: item.displayNameSnapshot } : file,
  };
}

/**
 * The items that survive projection, each still holding the draft row it came
 * from.
 *
 * Publishing needs both halves: the projected item goes into the snapshot, and
 * the draft row behind it carries the File id the relational item must point
 * at. Pairing them here is what lets **one** filtered list feed both, so the
 * snapshot and `presentation_revision_items` can never disagree about which
 * blocks a Revision has or what order they are in.
 */
export function presentedItems(
  items: PresentableItem[],
): { source: PresentableItem; presented: PresentedItem }[] {
  const kept: { source: PresentableItem; presented: PresentedItem }[] = [];

  for (const source of items) {
    const presented = toPresented(source);
    // **Renumbered to its place in the sequence, deliberately.** A draft's
    // `position` is an ordering key with gaps in it — `removeItem` does not
    // renumber and `nextPosition` is max + 1 — while a Revision's items are
    // written densely, by index. Carrying the draft's number into the frozen
    // content left two different meanings for the word `position` in one
    // system, and everything downstream had to guess which one it held. A
    // published Revision is a finished sequence, so its positions are that
    // sequence: 0, 1, 2 … with nothing missing.
    if (presented) kept.push({ source, presented: { ...presented, position: kept.length } });
  }

  return kept;
}

/**
 * The frozen content of a Presentation — the thing that is hashed and stored.
 *
 * Items arrive already ordered by the caller's query; this preserves that order
 * rather than sorting again, because the order **is** the content and a second
 * sort would be a second opinion about it.
 */
export function toPresentationContent(
  presentation: { title: string; intro: string },
  items: PresentableItem[],
): PresentationContent {
  return {
    title: presentation.title,
    intro: presentation.intro,
    items: presentedItems(items).map((entry) => entry.presented),
  };
}

/**
 * A complete client view: frozen content plus the facts around it.
 *
 * `content` comes from the stored snapshot for anything a client opens, and
 * from the live draft for a staff preview. Nothing else differs between the
 * two, which is what makes one component able to render both.
 */
export function toClientPresentationView(
  publicId: string,
  content: PresentationContent,
  facts: {
    publishedAt: Date | null;
    revision: number | null;
    revisions: { number: number; publishedAt: Date }[];
  },
  /**
   * Where **this** surface fetches file bytes from. The client's page passes
   * client-authorized routes; Studio's preview and its view of a published
   * version pass staff-authorized ones. The content is identical either way,
   * which is what lets one component render all three.
   */
  base: FileBase,
): ClientPresentation {
  return {
    id: publicId,
    title: content.title,
    intro: content.intro,
    items: content.items.map((item) =>
      item.kind === "note"
        ? item
        : { position: item.position, kind: "file", caption: item.caption, file: withPaths(item.file, base) },
    ),
    publishedAt: facts.publishedAt?.toISOString() ?? null,
    revision: facts.revision,
    revisions: facts.revisions.map((entry) => ({
      number: entry.number,
      publishedAt: entry.publishedAt.toISOString(),
      current: entry.number === facts.revision,
    })),
  };
}

/**
 * Deterministic serialisation, so the same content hashes the same way twice.
 *
 * `JSON.stringify` preserves insertion order, which means two objects holding
 * the same fields can serialise differently depending on how they were built.
 * Keys are therefore sorted at every level. Arrays are **not** sorted: their
 * order is the content.
 *
 * Written against the projection's own shape rather than generically — this is
 * the only thing it ever serialises, and a generic canonicaliser would invite
 * being reused on something whose ordering matters differently.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/* ------------------------------------------------- naming a part of a version */

/**
 * What one block is called when something else has to refer to it.
 *
 * A Review note carries an item **position**, which is an integer and useless
 * to a person. This turns it into the thing in that position, so a point reads
 * *On Cover artwork* rather than *On item 2* — and both worlds run the same
 * function, so the studio and the client are looking at the same name for the
 * same block.
 *
 * It never reaches for an identifier and never invents one: a file item is its
 * caption or the name the client was shown, and a note item is its heading or
 * the opening of what it says.
 */
export function itemLabel(item: ClientRevisionItem): string {
  // `caption?.trim() ||`, not `caption ??`: a stored empty string is not a
  // caption, and `??` would hand back "" — which every caller treats as
  // falsy and renders as nothing at all.
  if (item.kind === "file") return item.caption?.trim() || item.file.name;
  if (item.caption?.trim()) return item.caption.trim();

  const opening = item.body.trim().split(/\s*\n/, 1)[0] ?? "";
  return opening.length > 48 ? `${opening.slice(0, 47)}…` : opening || "A note in this version";
}

/** Every block a feedback point may be about, in the order they appear. */
export function itemSubjects(items: ClientRevisionItem[]): { value: string; label: string }[] {
  return items.map((item) => ({ value: String(item.position), label: itemLabel(item) }));
}

/** The label for one position, or null when that position is not in this version. */
export function labelAt(items: ClientRevisionItem[], position: number): string | null {
  const item = items.find((candidate) => candidate.position === position);
  return item ? itemLabel(item) : null;
}

/* ------------------------------------------------- reading a frozen Revision */

/**
 * The frozen content of one Revision.
 *
 * Read straight out of `snapshot`. The relational items beside it are the
 * integrity record — they carry the foreign keys, the archive guard and the
 * proof of which physical file belonged to a decision — but the thing the
 * client reads is the thing that was written for the client, unaltered.
 */
export function readSnapshot(value: unknown): PresentationContent {
  const snapshot = value as { title?: unknown; intro?: unknown; items?: unknown } | null;
  const items = Array.isArray(snapshot?.items) ? snapshot.items : [];

  return {
    title: typeof snapshot?.title === "string" ? snapshot.title : "",
    intro: typeof snapshot?.intro === "string" ? snapshot.intro : "",
    // **Renumbered on the way out, and that is a repair.** Revisions frozen
    // before `presentedItems` existed carry the draft's own ordering key, which
    // has gaps in it, while `presentation_revision_items` has always been
    // written densely by index — so the same block had two different numbers
    // depending on which table you asked, and a Review note named by one was
    // resolved against the other. The rows are immutable and are read rather
    // than rewritten, exactly as the frozen file paths above are. The order is
    // untouched, so nothing about what the client was shown changes; only the
    // label on each place in it does, and it now agrees with the relational
    // items it has always been in step with.
    items: items
      .map(readSnapshotItem)
      .filter((item): item is PresentedItem => item !== null)
      .map((item, position) => ({ ...item, position })),
  };
}

/**
 * One frozen item, normalised.
 *
 * Revisions published before routes were separated from content froze a file's
 * four paths into the snapshot. Those rows are immutable — correctly — so they
 * are read rather than rewritten: the file's opaque public id was always in
 * there, the routes are rebuilt per surface from it, and whether a thumbnail
 * exists is taken from the newer boolean or inferred from the old
 * `previewPath`. Nothing about what the client was shown changes either way.
 */
function readSnapshotItem(value: unknown): PresentedItem | null {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item.position !== "number") return null;

  if (item.kind === "note") {
    return {
      position: item.position,
      kind: "note",
      caption: typeof item.caption === "string" ? item.caption : null,
      body: typeof item.body === "string" ? item.body : "",
    };
  }

  if (item.kind !== "file") return null;
  const file = item.file as Record<string, unknown> | null;
  if (!file || typeof file.id !== "string") return null;

  return {
    position: item.position,
    kind: "file",
    caption: typeof item.caption === "string" ? item.caption : null,
    file: {
      id: file.id,
      name: typeof file.name === "string" ? file.name : "",
      kind: (typeof file.kind === "string" ? file.kind : "other") as FileKind,
      viewer: (typeof file.viewer === "string" ? file.viewer : "download") as ViewerKind,
      size: typeof file.size === "string" ? file.size : "",
      hasPreview:
        typeof file.hasPreview === "boolean" ? file.hasPreview : typeof file.previewPath === "string",
    },
  };
}

/**
 * How each block of one frozen Revision was shown, by its position.
 *
 * **The viewer kind an anchor is judged against comes from here**, and not
 * from the file as it is now. A Revision froze each file's `viewer` at the
 * moment it was published — what that version rendered, and therefore what a
 * point or a moment on it could have meant. Reading it back through the file
 * row instead would recompute it with today's rules from today's row, and a
 * Version 2 anchor has to be read as a Version 2 anchor for ever.
 *
 * A written note maps to `null`: words hold no precision. A position this
 * Revision does not have is simply absent, and an anchor on it fails closed.
 */
export function viewersByPosition(snapshot: unknown): Map<number, ViewerKind | null> {
  const viewers = new Map<number, ViewerKind | null>();
  for (const item of readSnapshot(snapshot).items) {
    viewers.set(item.position, item.kind === "file" ? item.file.viewer : null);
  }
  return viewers;
}
