/**
 * Where an object lives in the bucket.
 *
 * Every key is built here, from server-generated identifiers only. **No
 * caller-supplied string ever reaches a key** — not a filename, not a display
 * name, not anything a browser sent. Path traversal is therefore not defended
 * against; it is structurally impossible, because there is no path for a
 * hostile string to travel down.
 *
 * Two halves of a file's life, two shapes:
 *
 *   pending/{upload_id}                   transient. Swept by us at 24 hours.
 *   w/{workroom_id}/f/{file_id}           permanent. Never overwritten.
 *   w/{workroom_id}/f/{file_id}/preview   optional, browser-made, images only.
 *
 * The permanent key is **never the target of a presigned upload**. It is
 * written once, by a server-side copy the browser has no URL for, which is what
 * stops a stale upload link changing a file somebody already approved.
 */

export const PENDING_PREFIX = "pending/";
export const PERMANENT_PREFIX = "w/";

export function pendingKey(uploadId: string): string {
  return `${PENDING_PREFIX}${uploadId}`;
}

export function permanentKey(workroomId: string, fileId: string): string {
  return `${PERMANENT_PREFIX}${workroomId}/f/${fileId}`;
}

export function previewKey(workroomId: string, fileId: string): string {
  return `${permanentKey(workroomId, fileId)}/preview`;
}

/**
 * The guard the sweep asks before every delete.
 *
 * A bug elsewhere that wrote a permanent key into a `pending` row still cannot
 * delete a real file, because this is checked from the row rather than assumed
 * from the row's status. `w/` is unreachable from that code path by
 * construction, not by intention.
 */
export function isPendingKey(key: string): boolean {
  return key.startsWith(PENDING_PREFIX) && !key.includes("..");
}

export function isPermanentKey(key: string): boolean {
  return key.startsWith(PERMANENT_PREFIX) && !key.includes("..");
}
