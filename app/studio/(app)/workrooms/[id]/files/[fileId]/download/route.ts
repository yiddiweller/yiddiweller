import { currentStaff } from "@/lib/auth/guard";
import { fileForStaff } from "@/lib/db/files";
import { isId } from "@/lib/business";
import { presignGet } from "@/lib/storage/presign";
import { isPublicId } from "@/lib/workrooms/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The same file, for the studio.
 *
 * A separate route with a separate guard, and that separation is the point.
 * **Staff authorization is not client authorization**: this one checks
 * `currentStaff`, reads nothing from the client session, and applies no
 * visibility filter — seeing internal files is what internal means. A client
 * session reaching this address gets the same 404 as a stranger, because
 * `currentStaff` does not know that cookie exists.
 *
 * The two auth systems never meet here. Build 004 made that structural; this
 * route simply does not reach for the wrong one.
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
  // The file must belong to the Workroom in the address. Without this a valid
  // file id under the wrong Workroom would still resolve, which is untidy
  // rather than unsafe — but untidy is how the next hole gets in.
  if (!file || file.workroomId !== id) return notFound();

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

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
