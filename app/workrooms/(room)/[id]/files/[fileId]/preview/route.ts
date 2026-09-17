import { redirect } from "next/navigation";

import { currentViewer } from "@/lib/client-auth/guard";
import { fileForViewer } from "@/lib/db/files";
import { presignPreview } from "@/lib/storage/presign";
import { isPublicId } from "@/lib/workrooms/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A browser-made preview of one image, for the client it belongs to.
 *
 * The same authorization as the download beside it, deliberately: a preview is
 * a smaller copy of private work, not a public thumbnail. The only difference
 * is that this one may be shown inline, because it exists only for image types
 * a browser can safely decode — never for SVG, which is why `previewable()`
 * excludes it.
 *
 * **Authorization happens here, before the read, and inside the read**, by the
 * same single guarded query the download uses.
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
  // No preview is the same answer as no file. A client asking for one that was
  // never made learns nothing they did not already know.
  if (!file || !file.previewKey) return notFound();

  const url = await presignPreview(file.previewKey);

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
