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

export function toClientFile(row: WorkroomFileRow, workroomPublicId: string): ClientFile {
  const base = `/workrooms/${workroomPublicId}/files/${row.publicId}`;
  const viewer = viewerKind(row.contentType);

  return {
    id: row.publicId,
    name: row.displayName,
    kind: fileKind(row.contentType),
    viewer,
    size: formatBytes(row.byteSize ?? 0),
    downloadPath: `${base}/download`,
    ...(viewer === "download" ? {} : { viewPath: base, sourcePath: `${base}/view` }),
    ...(row.previewKey ? { previewPath: `${base}/preview` } : {}),
  };
}

export function toClientFiles(rows: WorkroomFileRow[], workroomPublicId: string): ClientFile[] {
  return rows.map((row) => toClientFile(row, workroomPublicId));
}
