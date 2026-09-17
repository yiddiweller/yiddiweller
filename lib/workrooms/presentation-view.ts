import { type WorkroomFileRow } from "../db/files.ts";
import { toClientFile, type ClientFile } from "./delivery-view.ts";

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

export type ClientRevisionItem =
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
      file: ClientFile;
    };

/** Exactly what is frozen at publication, and exactly what the hash covers. */
export type PresentationContent = {
  title: string;
  intro: string;
  items: ClientRevisionItem[];
};

/** One entry in `Previous versions`: which, and when. Never what changed. */
export type ClientRevisionRef = {
  number: number;
  publishedAt: string;
  current: boolean;
};

export type ClientPresentation = PresentationContent & {
  /** The opaque public id. The only identifier a client ever receives. */
  id: string;
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

/** What a draft item or a frozen revision item looks like before projection. */
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
function toClientItem(
  item: PresentableItem,
  workroomPublicId: string,
): ClientRevisionItem | null {
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

  const file = toClientFile(item.file, workroomPublicId);

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
 * The frozen content of a Presentation — the thing that is hashed and stored.
 *
 * Items arrive already ordered by the caller's query; this preserves that order
 * rather than sorting again, because the order **is** the content and a second
 * sort would be a second opinion about it.
 */
export function toPresentationContent(
  presentation: { title: string; intro: string },
  items: PresentableItem[],
  workroomPublicId: string,
): PresentationContent {
  const projected: ClientRevisionItem[] = [];

  for (const item of items) {
    const safe = toClientItem(item, workroomPublicId);
    if (safe) projected.push(safe);
  }

  return {
    title: presentation.title,
    intro: presentation.intro,
    items: projected,
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
): ClientPresentation {
  return {
    id: publicId,
    title: content.title,
    intro: content.intro,
    items: content.items,
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
