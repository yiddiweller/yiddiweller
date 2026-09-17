import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/client-auth/guard";
import { fileForViewer } from "@/lib/db/files";
import { presignGet } from "@/lib/storage/presign";
import { isPublicId } from "@/lib/workrooms/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One file, for the client it belongs to.
 *
 * A Route Handler rather than a server action, because the answer is a redirect
 * rather than a mutation — and a redirect is what keeps the bytes off this
 * server. The signed URL is minted per request, lives for a minute, and never
 * appears in HTML, in an email or in a log.
 *
 * **Authorization happens here, before the read, and inside the read.**
 * `fileForViewer` puts membership, the Workroom's published and unarchived
 * state, the file's Workroom, its readiness, its visibility and its archive
 * state into one `WHERE`. So an unknown file, another client's file, an
 * internal file, a pending file, an archived file and a revoked member all
 * produce the same 404 — because they all produce the same nothing, not because
 * six branches each remembered to.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const viewer = await currentViewer();
  if (!viewer) redirect("/workrooms/login");

  const { id, fileId } = await params;
  if (!isPublicId(id) || !isPublicId(fileId)) return notFound();

  const file = await fileForViewer(viewer.contactId, id, fileId);
  if (!file) return notFound();

  // The disposition is forced at signing time from the client-facing name, so
  // a filename carrying quotes or newlines cannot inject a header, and nothing
  // is ever served inline from our origin.
  const url = await presignGet(file.storageKey, file.displayName);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "Referrer-Policy": "same-origin",
    },
  });
}

/** The same answer for every refusal, with nothing in the body to compare. */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
