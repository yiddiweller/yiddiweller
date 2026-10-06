import { studioUrl, workroomUrl } from "../env.ts";
import { isPublicId } from "../workrooms/id.ts";
import { revisionLocatorHref } from "../workrooms/review-locator.ts";

/**
 * The only two links a Stage G message carries (G2), built from the
 * application's own origins — `workroomUrl()` and `studioUrl()` — and its own
 * routes. Each names **one immutable Revision by its number**, never "the
 * latest", so a message about Version 2 still opens Version 2 after Version 3
 * is published. G0 carries either link through signing in.
 *
 * Never a file route, a media `/view` URL, a signed storage URL, a bucket
 * address or a sign-in token: a message links to a page, and the page runs its
 * own checks on whoever opens it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function positive(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${what} is not a positive whole number`);
  return value;
}

function handle(value: string, valid: (value: string) => boolean, what: string): string {
  if (!valid(value)) throw new Error(`${what} is not a handle`);
  return value;
}

const isUuid = (value: string) => UUID.test(value);

/** The client's page for one Revision: `/workrooms/{room}/presentations/{presentation}/revisions/{N}`. */
export function clientRevisionUrl(input: { room: string; presentation: string; version: number }): string {
  const room = handle(input.room, isPublicId, "room");
  const presentation = handle(input.presentation, isPublicId, "presentation");
  return workroomUrl(`/${room}/presentations/${presentation}/revisions/${positive(input.version, "version")}`);
}

/**
 * Studio's page for one Revision, opened on one note:
 * `…/workrooms/{id}/presentations/{id}/revisions/{N}?note={n}` — the same
 * shape Studio's own draft page links to, from the same function.
 */
export function studioRevisionUrl(input: {
  workroomId: string;
  presentationId: string;
  version: number;
  note: number;
}): string {
  const workroom = handle(input.workroomId, isUuid, "workroomId");
  const presentation = handle(input.presentationId, isUuid, "presentationId");
  return `${studioUrl()}${revisionLocatorHref(
    `/workrooms/${workroom}/presentations/${presentation}`,
    positive(input.version, "version"),
    positive(input.note, "note"),
  )}`;
}
