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

/** The only types anything ever renders. Everything else is a download row. */
const INLINE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"];
const INLINE_VIDEO_TYPES = ["video/mp4", "video/webm"];

/** What the client is told a file is. A coarse word, never the raw type. */
export type FileKind = "image" | "pdf" | "video" | "document" | "other";

export function fileKind(contentType: string): FileKind {
  const type = contentType.toLowerCase();
  if (INLINE_IMAGE_TYPES.includes(type)) return "image";
  if (type === "application/pdf") return "pdf";
  if (INLINE_VIDEO_TYPES.includes(type)) return "video";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || type.startsWith("application/")) return "document";
  return "other";
}

/**
 * Whether a browser may decode this to make a preview.
 *
 * **SVG is deliberately absent.** Decoding one runs its contents, and an SVG
 * served from our own origin is stored XSS. It may be stored and downloaded; it
 * is never previewed and never rendered inline.
 */
export function previewable(contentType: string): boolean {
  return INLINE_IMAGE_TYPES.includes(contentType.toLowerCase());
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
