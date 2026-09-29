import { log } from "../log.ts";
import { viewerKind } from "./policy.ts";

/**
 * The one line a player's recovery leaves in the logs (Stage F6.2).
 *
 * When `MediaPlayer` goes back through a view route to replace an expired
 * signed address, its request carries a `refresh` marker. A view route calls
 * this **after** it has authorized the request and just before it signs a
 * fresh inline URL, so the line means exactly *a refresh reached us and was
 * served* — a refusal leaves nothing here.
 *
 * **Two facts and nothing else**: which route (the client's or Studio's) and
 * the viewer kind. Never the file, the Workroom, the person, the key, the
 * filename, the signed address, the marker's value or anything from a Review:
 * the line is for seeing that recovery happens, not for finding who or what.
 */
export function logViewRefresh(request: Request, route: "client" | "studio", contentType: string): void {
  if (!new URL(request.url).searchParams.has("refresh")) return;
  log.info("file.view_refreshed", { route, viewer: viewerKind(contentType) });
}
