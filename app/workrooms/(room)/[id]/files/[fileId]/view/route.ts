import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/client-auth/guard";
import { fileForViewer } from "@/lib/db/files";
import { presignInline } from "@/lib/storage/presign";
import { viewable } from "@/lib/storage/policy";
import { isPublicId } from "@/lib/workrooms/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The bytes of one file, for a browser to render in place.
 *
 * The sibling of `download`, and different from it in exactly one respect: the
 * signed URL carries `Content-Disposition: inline` instead of `attachment`.
 * Everything about who may have it is identical, because it is the same
 * `fileForViewer` read — membership, published state, ownership, readiness,
 * visibility and archive state in one `WHERE`.
 *
 * **What may render inline is decided here, from what is stored.** `viewable()`
 * reads the file's recorded content type against an exact allowlist; anything
 * that answers `download` gets the same 404 as a file that does not exist. A
 * request cannot ask for inline treatment, and an uploader cannot obtain it by
 * naming a file cleverly — the only input is a value this build approved when
 * the bytes were stored.
 *
 * That is why SVG is unreachable through this route. It is storable and
 * downloadable and is never `viewable`, because a browser decoding one runs its
 * contents.
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
  if (!file || !viewable(file.contentType)) return notFound();

  const url = await presignInline(file.storageKey, file.contentType);

  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "private, no-store, max-age=0, must-revalidate",
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
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
