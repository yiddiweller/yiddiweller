import MediaPlayer from "@/components/workrooms/MediaPlayer";
import { type ViewerKind } from "@/lib/storage/policy";
import { effectiveViewTtlSeconds } from "@/lib/storage/view-ttl";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * One file, looked at.
 *
 * **One component for every type, not a viewer per format.** The kind is
 * decided once, on the server, from the file's stored content type — this only
 * chooses which element renders it. That matters beyond tidiness: if each
 * surface picked its own element from its own guess at the type, the rule about
 * what may render inline would exist in as many places as there are pages, and
 * one of them would eventually be wrong about SVG.
 *
 * `source` is always one of our own authorized routes, never a signed URL. The
 * browser follows the redirect inside the element, so the storage address
 * reaches neither this markup nor the address bar, and the route re-checks
 * membership on every request rather than trusting that this page rendered.
 *
 * Used by the client's viewer page and by Studio's, which differ only in which
 * routes they are handed.
 *
 * **A recording or a video is `MediaPlayer`'s** (Stage F6.2): the same native
 * element, which also recovers — once, paused — when its signed address runs
 * out. It is given only the view URL's lifetime, as the window for that, and
 * a new player per source. An image, a PDF and a download card are exactly
 * as they were: nothing recovers them automatically.
 */

export default function FileViewer({
  kind,
  source,
  name,
}: {
  kind: ViewerKind;
  /** Our own route. Absent when there is nothing this build will render. */
  source?: string;
  name: string;
}) {
  if (!source || kind === "download") {
    return (
      <div className={styles.viewerEmpty} role="status">
        <p className={styles.viewerEmptyTitle}>No preview for this kind of file.</p>
        <p>
          It is here and it is yours — download it to open it in the application it was made for.
        </p>
      </div>
    );
  }

  if (kind === "image") {
    return (
      <div className={`${styles.viewerStage} ${styles.viewerStageImage}`}>
        {/* `contain`, never `cover`. A thumbnail may crop to stay recognisable
            in a list; the full view is the artwork, and cropping somebody's
            work to fit a box is the one thing a viewer must not do. */}
        <img className={styles.viewerImage} src={source} alt={name} decoding="async" />
      </div>
    );
  }

  if (kind === "pdf") {
    return (
      <div className={`${styles.viewerStage} ${styles.viewerStageDocument}`}>
        {/* The browser's own PDF viewer. Nothing is rasterised and nothing is
            converted — the bytes go to the browser as they were uploaded.

            It renders from the storage origin rather than ours, so it is
            already isolated from this application by the same-origin policy,
            and `title` is what a screen reader announces for the frame. */}
        <iframe className={styles.viewerFrame} src={source} title={`${name} — document`} />
      </div>
    );
  }

  return <MediaPlayer key={source} kind={kind} source={source} windowSeconds={effectiveViewTtlSeconds()} />;
}
