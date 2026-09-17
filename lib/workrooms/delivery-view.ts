import { type WorkroomFileRow } from "../db/files.ts";
import {
  fileKind,
  formatBytes,
  viewerKind,
  type FileKind,
  type ViewerKind,
} from "../storage/policy.ts";

/**
 * The only shape of a delivery object that reaches a client surface.
 *
 * **A whitelist, not a filter**, exactly as `view.ts` is. Every field a client
 * sees is named here, and a database row is never spread into a client
 * component — hiding a field in markup leaves it in the response, and Build 003
 * learned what that costs when a record's name travelled inside a 307.
 *
 * What is deliberately absent, and never fetched on a client request:
 * `storage_key`, `preview_key`, `storage_etag`, `original_filename`, the raw
 * `content_type`, the raw byte count, `uploaded_by`, `version`, every internal
 * id, every `internal` file, every `pending` file, every archived file, and
 * every other Workroom's anything. The paths here are our own routes; a signed
 * URL is minted per request behind one of them and never travels in a
 * projection.
 *
 * `original_filename` stays internal on purpose. It is where
 * `final_v7_CLIENTNAME_dontsend.pdf` lives. The client sees `name`, which
 * somebody chose.
 */

export type ClientFile = {
  /** The opaque public id. The only identifier a client ever receives. */
  id: string;
  name: string;
  /** A word — `image`, `pdf`, `video`, `audio`, … — never a MIME type. */
  kind: FileKind;
  /**
   * How it may be looked at: `image`, `pdf`, `video`, `audio`, or `download`
   * for everything this build will not render. Derived from the stored content
   * type, never from anything a request supplied — and the page reads it rather
   * than deciding for itself, so there is one answer in one place.
   */
  viewer: ViewerKind;
  /** Already written out: "2.4 MB", not 2516582. */
  size: string;
  /** Always present. A download is offered for every file, without exception. */
  downloadPath: string;
  /** The page that opens it. Absent when there is nothing to open. */
  viewPath?: string;
  /** The bytes, inline. Absent for anything not `viewable`. */
  sourcePath?: string;
  /** A browser-made thumbnail. Raster images only. */
  previewPath?: string;
};

/**
 * A file as **content**, with no idea where its bytes are fetched from.
 *
 * This is what a Presentation Revision freezes. Paths are a property of the
 * surface doing the rendering, not of the work: the same published Revision is
 * read by a client through client-authorized routes and by staff through
 * staff-authorized ones, and neither of those is a fact about what was
 * delivered. Keeping them out also keeps the content hash honest — a future
 * change to our routing must not alter the hash of work published last year.
 */
export type PresentedFile = {
  id: string;
  name: string;
  kind: FileKind;
  viewer: ViewerKind;
  size: string;
  /** Whether a browser-made thumbnail exists. Raster images only. */
  hasPreview: boolean;
};

/**
 * Where a surface fetches one file's bytes from.
 *
 * Both bases point at **our own** routes, never at storage, and each re-checks
 * authorization on every request rather than trusting that a page rendered.
 * The client's requires `ready`, `shared`, unarchived and active membership;
 * the studio's requires staff and the file's own Workroom, and deliberately
 * applies no visibility filter — looking at an internal file is what internal
 * means.
 */
export type FileBase = (filePublicId: string) => string;

export const clientFileBase =
  (workroomPublicId: string): FileBase =>
  (filePublicId) =>
    `/workrooms/${workroomPublicId}/files/${filePublicId}`;

export const studioFileBase =
  (workroomId: string): FileBase =>
  (filePublicId) =>
    `/studio/workrooms/${workroomId}/files/${filePublicId}`;

export function toPresentedFile(row: WorkroomFileRow): PresentedFile {
  return {
    id: row.publicId,
    name: row.displayName,
    kind: fileKind(row.contentType),
    viewer: viewerKind(row.contentType),
    size: formatBytes(row.byteSize ?? 0),
    hasPreview: Boolean(row.previewKey),
  };
}

/** The one place the shape of a file's four routes is written down. */
export function withPaths(file: PresentedFile, base: FileBase): ClientFile {
  const at = base(file.id);

  return {
    id: file.id,
    name: file.name,
    kind: file.kind,
    viewer: file.viewer,
    size: file.size,
    downloadPath: `${at}/download`,
    ...(file.viewer === "download" ? {} : { viewPath: at, sourcePath: `${at}/view` }),
    ...(file.hasPreview ? { previewPath: `${at}/preview` } : {}),
  };
}

export function toClientFile(row: WorkroomFileRow, workroomPublicId: string): ClientFile {
  return withPaths(toPresentedFile(row), clientFileBase(workroomPublicId));
}

export function toClientFiles(rows: WorkroomFileRow[], workroomPublicId: string): ClientFile[] {
  return rows.map((row) => toClientFile(row, workroomPublicId));
}
