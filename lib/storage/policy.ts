/**
 * What may be stored, and what may be rendered. Two different questions.
 *
 * A design studio's files are unpredictable — `.sketch`, `.fig`, `.ai`,
 * `.indd`, `.psd`, `.zip`, `.mov`, `.aep` — and refusing an unfamiliar
 * extension is how a tool becomes useless on a Tuesday. So almost everything is
 * **accepted**, and only a short list is **rendered**.
 *
 * Content type is metadata. It is recorded because it is useful, and it is
 * never trusted to decide what happens to the bytes.
 */

/** 2 GB. Verified against the bucket at finalization, never from the browser. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** A warning to staff, never a wall. Nothing breaks when it is crossed. */
export const WORKROOM_SOFT_BYTES = 50 * 1024 * 1024 * 1024;

/**
 * Refused outright. Not because of storage, but because no legitimate
 * deliverable is an executable, and nothing we send a client should be one.
 */
const REFUSED_EXTENSIONS = [
  ".exe", ".dll", ".bat", ".cmd", ".com", ".sh", ".msi", ".app", ".scr", ".ps1", ".vbs", ".jar",
];

/**
 * Refused declared types. `text/html` is here because a stored HTML document is
 * the one thing that becomes active content the moment anything serves it
 * inline — and the studio has no reason to deliver one.
 */
const REFUSED_TYPES = ["text/html", "application/x-msdownload", "application/x-msdos-program"];

/**
 * The only types anything ever renders, and the only ones that may ever be
 * served with an inline disposition.
 *
 * **Exact matches, never prefixes.** `image/*` would admit SVG, which executes
 * when a browser decodes it; `application/*` would admit anything at all. A
 * prefix test here is the difference between a viewer and an XSS surface, and
 * it is the reason `viewerKind()` exists beside `fileKind()`: one says what a
 * file *is*, the other says what we are willing to *do* with it.
 */
const INLINE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const INLINE_VIDEO_TYPES = ["video/mp4", "video/webm", "video/ogg"];
const INLINE_AUDIO_TYPES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
];
const INLINE_PDF_TYPE = "application/pdf";

/** What the client is told a file is. A coarse word, never the raw type. */
export type FileKind = "image" | "pdf" | "video" | "audio" | "document" | "other";

export function fileKind(contentType: string): FileKind {
  const type = contentType.toLowerCase();
  if (INLINE_IMAGE_TYPES.includes(type)) return "image";
  if (type === INLINE_PDF_TYPE) return "pdf";
  if (INLINE_VIDEO_TYPES.includes(type)) return "video";
  if (INLINE_AUDIO_TYPES.includes(type)) return "audio";
  // Prefixes are fine here and nowhere else: this only chooses a word to show
  // somebody. An SVG reads as an image and is still never rendered as one.
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("text/") || type.startsWith("application/")) return "document";
  return "other";
}

/**
 * Whether a browser may decode this to make a thumbnail.
 *
 * **SVG is deliberately absent.** Decoding one runs its contents, and an SVG
 * served from our own origin is stored XSS. It may be stored and downloaded; it
 * is never previewed and never rendered inline.
 */
export function previewable(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.includes(contentType.toLowerCase());
}

/**
 * How a file may be looked at in the product, if at all.
 *
 * This is the **single decision** about inline rendering. The view route reads
 * it from the file's stored content type and refuses anything answering
 * `download` — so arbitrary content can never talk its way into an inline
 * disposition, no matter what a request asks for. Nothing else in the codebase
 * decides this, and nothing should.
 *
 * The line is drawn where a browser can render something safely without us
 * converting it. Everything past that line — Office documents, Adobe sources,
 * archives, CAD — is a download, and stays one until there is conversion
 * infrastructure to change the answer. That is a deliberate scope boundary, not
 * an omission: the product pattern is the same as the platforms that do run
 * those pipelines, minus the pipelines.
 */
export type ViewerKind = "image" | "pdf" | "video" | "audio" | "download";

export function viewerKind(contentType: string): ViewerKind {
  const type = contentType.trim().toLowerCase();
  if (INLINE_IMAGE_TYPES.includes(type)) return "image";
  if (type === INLINE_PDF_TYPE) return "pdf";
  if (INLINE_VIDEO_TYPES.includes(type)) return "video";
  if (INLINE_AUDIO_TYPES.includes(type)) return "audio";
  return "download";
}

/** Whether this file has a viewer at all. */
export function viewable(contentType: string): boolean {
  return viewerKind(contentType) !== "download";
}

export type PolicyRefusal = { ok: false; reason: string };
export type PolicyPass = { ok: true };

/** Checked against what the browser *declares*, before anything is issued. */
export function checkUpload(input: {
  filename: string;
  contentType: string;
  declaredSize: number;
}): PolicyPass | PolicyRefusal {
  const name = input.filename.trim();
  if (name.length === 0) return { ok: false, reason: "That file has no name." };
  if (name.length > 400) return { ok: false, reason: "That filename is too long." };

  const lower = name.toLowerCase();
  if (REFUSED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return { ok: false, reason: "Executable files are not accepted." };
  }

  const type = input.contentType.trim().toLowerCase();
  if (type.length === 0 || type.length > 200) {
    return { ok: false, reason: "That file type is not usable." };
  }
  if (REFUSED_TYPES.includes(type)) {
    return { ok: false, reason: "That file type is not accepted." };
  }

  if (!Number.isSafeInteger(input.declaredSize) || input.declaredSize <= 0) {
    return { ok: false, reason: "That file is empty." };
  }
  if (input.declaredSize > MAX_FILE_BYTES) {
    return { ok: false, reason: "That file is larger than 2 GB." };
  }

  return { ok: true };
}

/** Bytes, as a person reads them. Formatted on the server, never raw. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
