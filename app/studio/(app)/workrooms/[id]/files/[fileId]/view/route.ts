import { currentStaff } from "@/lib/auth/guard";
import { fileForStaff } from "@/lib/db/files";
import { isId } from "@/lib/business";
import { presignInline } from "@/lib/storage/presign";
import { viewable } from "@/lib/storage/policy";
import { isPublicId } from "@/lib/workrooms/id";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The same bytes, inline, for the studio.
 *
 * Staff authorization, no visibility filter — looking at an internal file is
 * what internal means. The inline decision is the same one the client route
 * makes, from the same stored content type, so an SVG is as unviewable here as
 * it is there: the rule protects the person looking, not the tenancy.
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
  if (!file || file.workroomId !== id || !viewable(file.contentType)) return notFound();

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

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { "Cache-Control": "private, no-store, max-age=0, must-revalidate" },
  });
}
