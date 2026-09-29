"use client";

import { useEffect, useRef, useState } from "react";

import {
  initialRecovery,
  recover,
  RECOVERED_EVENT,
  RECOVERY_ATTRIBUTE,
  RECOVERY_FAILED_EVENT,
  RECOVERY_TIMEOUT_MS,
  refreshSource,
  restoreSeek,
  type RecoveryAction,
  type RecoveryEvent,
  type RecoveryState,
} from "@/lib/workrooms/media-recovery";
import styles from "@/app/workrooms/workroom.module.css";

/**
 * A recording or a video, in the browser's own player — and put back when its
 * signed address runs out (Stage F6.2).
 *
 * **The markup is `FileViewer`'s, unchanged**: the same native `<audio
 * controls preload="metadata">` or `<video controls preload="metadata"
 * playsInline>`, the same wrapper, the same fallback sentence. What this adds
 * is only what a browser has to do: the player's `src` is our own `/view`
 * route, which authorizes and redirects to a signed bucket address that lives
 * for the view TTL; the browser asks our route once and then fetches byte
 * ranges from that address directly. When one of those is refused — a seek
 * into bytes not yet fetched, after the address has lapsed — the element
 * reports a network error, and this goes back **once** through our route with
 * a refresh marker, where authorization runs again, and puts the player back
 * where it was.
 *
 * **Paused, always.** The time is restored; playing is not. Nothing here calls
 * `play()`. **One automatic refresh per window**, the window being the view
 * URL's lifetime (`windowSeconds`, from the server): the rules are
 * `media-recovery.ts`'s, and this only carries them out. If the refresh fails
 * too — or the refreshed player fails again before its window is out — one
 * calm line under the player says so and offers *Try again*, the only thing
 * that starts another attempt, beside the Download that is always there.
 *
 * It holds a time and a clock reading, never an address, a file, a person or
 * a Review. A locator or a capture panel driving the same element reads the
 * element's `data-recovery` and waits for `media-recovered`; this component
 * knows nothing about them.
 */
export default function MediaPlayer({
  kind,
  source,
  windowSeconds,
}: {
  kind: "audio" | "video";
  /** Our own `/view` route. Never a signed address. */
  source: string;
  /** The view URL's lifetime, which is the automatic-refresh window. */
  windowSeconds: number;
}) {
  const media = useRef<HTMLMediaElement | null>(null);
  const [generation, setGeneration] = useState(0);
  const [failed, setFailed] = useState(false);

  const state = useRef<RecoveryState>(initialRecovery);
  // Whether the current source reached its metadata, reset with each source.
  const hadMetadata = useRef(false);
  // Where the person meant to be: the time at the failure, kept for Try again.
  const intended = useRef(0);
  const timer = useRef<number | null>(null);
  const windowMs = windowSeconds * 1000;

  useEffect(() => {
    const element = media.current;
    if (!element) return;

    const clearTimer = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };

    const act = (action: RecoveryAction) => {
      clearTimer();
      switch (action.type) {
        case "refresh":
          element.setAttribute(RECOVERY_ATTRIBUTE, "refreshing");
          hadMetadata.current = false;
          setFailed(false);
          setGeneration((current) => current + 1);
          timer.current = window.setTimeout(() => step({ type: "timeout" }), RECOVERY_TIMEOUT_MS);
          return;
        case "restore": {
          // Paused first and paused after: nothing here ever plays.
          element.pause();
          const seek = restoreSeek(action.seek, element.duration);
          if (seek === null || Math.abs(element.currentTime - seek) < 0.001) {
            step({ type: "restored" });
            return;
          }
          element.currentTime = seek;
          timer.current = window.setTimeout(() => step({ type: "timeout" }), RECOVERY_TIMEOUT_MS);
          return;
        }
        case "give_up":
          element.setAttribute(RECOVERY_ATTRIBUTE, "failed");
          // The line says a refresh failed only when one was attempted: the
          // fresh source failing, or failing again inside the window it
          // opened. A player that never loaded was never refreshed.
          if (action.reason !== "not_recoverable") setFailed(true);
          element.dispatchEvent(new Event(RECOVERY_FAILED_EVENT));
          return;
        case "none":
          return;
      }
    };

    const step = (event: RecoveryEvent) => {
      const before = state.current.phase;
      const next = recover(state.current, event, windowMs);
      state.current = next.state;
      act(next.action);
      if (before === "restoring" && next.state.phase === "ready") {
        element.removeAttribute(RECOVERY_ATTRIBUTE);
        element.dispatchEvent(new Event(RECOVERED_EVENT));
      }
    };

    const onMetadata = () => {
      hadMetadata.current = true;
      step({ type: "metadata" });
    };
    const onSeeked = () => {
      if (state.current.phase === "restoring") step({ type: "restored" });
    };
    const onError = () => {
      const at = element.currentTime;
      if (state.current.phase === "ready") intended.current = at;
      step({
        type: "error",
        failure: { code: element.error?.code ?? null, hadMetadata: hadMetadata.current },
        at,
        now: Date.now(),
      });
    };
    const onRetry = () => {
      step({ type: "retry", at: intended.current, now: Date.now() });
    };

    element.addEventListener("loadedmetadata", onMetadata);
    element.addEventListener("seeked", onSeeked);
    element.addEventListener("error", onError);
    element.addEventListener("recovery-retry", onRetry);
    // The element may have its metadata before this ran.
    if (element.readyState >= 1) hadMetadata.current = true;

    return () => {
      clearTimer();
      element.removeEventListener("loadedmetadata", onMetadata);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("error", onError);
      element.removeEventListener("recovery-retry", onRetry);
    };
  }, [windowMs]);

  const src = refreshSource(source, generation);

  // *Try again* goes through the same rules as everything else: a retry event
  // on the element, heard by the one listener that owns recovery.
  const retry = () => media.current?.dispatchEvent(new Event("recovery-retry"));

  const line = failed ? (
    <p className={styles.viewerRecovery} role="status">
      {"This preview couldn't be refreshed. Try again, or download the original. "}
      <button type="button" className={styles.viewerRetry} onClick={retry}>
        Try again
      </button>
    </p>
  ) : null;

  if (kind === "video") {
    return (
      <>
        <div className={styles.viewerStage}>
          {/* Native controls, no autoplay and `preload="metadata"`: a client
              opening a Workroom on a phone should not start downloading a
              gigabyte, and should never be surprised by sound. */}
          <video
            ref={(element) => {
              media.current = element;
            }}
            className={styles.viewerVideo}
            src={src}
            controls
            preload="metadata"
            playsInline
          >
            <p>This video cannot play in your browser. Download it to watch it in another player.</p>
          </video>
        </div>
        {line}
      </>
    );
  }

  return (
    <>
      <div className={styles.viewerAudio}>
        <audio
          ref={(element) => {
            media.current = element;
          }}
          className={styles.viewerAudioPlayer}
          src={src}
          controls
          preload="metadata"
        >
          <p>This audio cannot play in your browser. Download it to listen another way.</p>
        </audio>
      </div>
      {line}
    </>
  );
}
