import Link from "next/link";
import { notFound } from "next/navigation";

import PresentationView from "@/components/workrooms/PresentationView";
import { requireStaff } from "@/lib/auth/guard";
import { isId } from "@/lib/business";
import { draftPreview, findPresentation } from "@/lib/db/presentations";
import { findWorkroom } from "@/lib/db/workrooms";
import studio from "@/app/studio/studio.module.css";
import styles from "@/app/workrooms/workroom.module.css";

export const metadata = { title: "Preview" };

/**
 * The draft, as it would publish.
 *
 * It renders `PresentationView` — **the same component the client's own page
 * renders**, not a copy of it. That is what makes the sentence on the page
 * true, and it was not always: Build 005 Stage A added a Files section to a
 * client page and left the staff preview behind, so a shared file appeared in a
 * client's Workroom and was invisible to the person checking their work.
 * Nothing failed; the preview simply showed an older product, which is the
 * worst way for a verification surface to be wrong.
 *
 * **This is the draft, deliberately — not what the client is reading.** For a
 * published Presentation the two differ exactly when somebody has edited
 * without republishing, and that is the state this page exists to show. What
 * the client currently has is the current version, under Versions.
 *
 * It is a staff-authorized Studio route. It issues no client session, and there
 * is no "sign in as this client" anywhere in this product.
 */
export default async function StudioPresentationPreview({
  params,
}: {
  params: Promise<{ id: string; pid: string }>;
}) {
  await requireStaff();
  const { id, pid } = await params;
  if (!isId(id) || !isId(pid)) notFound();

  const [room, presentation] = await Promise.all([findWorkroom(id), findPresentation(pid)]);
  if (!room || !presentation || presentation.workroomId !== room.id) notFound();

  const view = await draftPreview(presentation, room.publicId);

  return (
    <>
      <Link
        className={studio.back}
        href={`/studio/workrooms/${room.id}/presentations/${presentation.id}`}
      >
        ← {presentation.title}
      </Link>

      <div className={studio.notice}>
        <p className={studio.noticeTitle}>This is the draft, in the client&rsquo;s view.</p>
        <p>
          The same component and the same projection the real page uses, so nothing here is a
          mock-up.{" "}
          {presentation.status === "published"
            ? "It is not what the client is reading — that is the current version, until this is published."
            : "Nothing here has reached the client."}
        </p>
      </div>

      <div className={`${styles.tokens} ${studio.section}`}>
        <PresentationView
          presentation={view}
          notice="Draft — not published"
        />
      </div>
    </>
  );
}
