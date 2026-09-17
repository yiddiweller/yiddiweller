import { currentStaff } from "@/lib/auth/guard";
import { fileForStaff } from "@/lib/db/files";
import { isId } from "@/lib/business";
import { presignPreview } from "@/lib/storage/presign";
import { isPublicId } from "@/lib/workrooms/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A file's preview image, for the studio.
 *
 * The staff counterpart of the client route, and separate for the same reason
 * the downloads are: **staff authorization is not client authorization.** This
 * checks `currentStaff`, reads nothing from the client session, and applies no
 * visibility filter — recognising an internal image at a glance is most of why
 * a thumbnail is worth having.
 *
 * It serves the browser-made preview, never the original. There is no
 * server-side image processing anywhere in this build, so a file with no
 * preview object simply has no thumbnail, and that is a row rather than an
 * error.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; fileId: string }> },
) {
  const staff = await currentStaff();
  if (!staff) return notFound();

  const { id, fileId } = await params;
  if (!isId(id) || !isPublicId(fileId)) return notFound();

  const file = await fileForStaff(fileId);
  // The file must belong to the Workroom in the address, so a valid id under
  // the wrong Workroom does not resolve.
  if (!file || file.workroomId !== id || !file.previewKey) return notFound();

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

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
