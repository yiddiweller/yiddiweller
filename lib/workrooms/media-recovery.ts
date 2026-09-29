/**
 * Recovering a player whose signed URL has expired — the rules, as data
 * (Stage F6.1). F6.2 wires them to the players; nothing here touches one.
 *
 * **Why it is needed, measured.** A player's `src` is our own `/view` route,
 * which authorizes and redirects to a signed bucket URL. The browser asks our
 * route once; every later byte-range request goes straight to the signed URL.
 * Fifteen minutes on, a seek into bytes not yet fetched is refused by the
 * bucket, and the element reports a *network* error — the same error a server
 * fault or a dropped connection gives, because the page is never told the
 * status. So recovery cannot be for expiry alone: it is **one** fresh request
 * through our route — where authorization runs again, and a person whose
 * access was withdrawn is refused — after a network failure on a player that
 * had already loaded, and never a loop.
 *
 * **The rules.**
 *
 * - Only a *network* failure (`MediaError.MEDIA_ERR_NETWORK`) on an element
 *   that had reached its metadata qualifies. A failure before metadata — a
 *   file that never loaded, a codec the browser cannot play, access refused on
 *   the first request — is never retried.
 * - At most **one** automatic refresh per window, and the window is the view
 *   URL's own lifetime: a fresh URL cannot legitimately expire sooner, so a
 *   second failure inside it is not expiry, and it stops.
 * - A refresh that fails, or a restore that fails, stops. It is `failed`, and
 *   only a person pressing *Try again* (F6.2) starts another.
 * - A remount or a navigation starts from `initialRecovery` — a fresh state.
 *
 * **Recovery always ends paused.** It restores *where* the player was, never
 * *whether* it was playing: `restore` carries `playback: "paused"` and nothing
 * else can be expressed. A recovery runs from an error, not from a person's
 * press, and a phone refuses to start audible playback without one — so
 * resuming would be unreliable exactly where it matters, and a surprise
 * everywhere else. This is a product rule, not a detail of the tests.
 *
 * **Nothing else is held.** A time and a clock reading. No URL, signed or
 * otherwise, no file, no person, no Review, no anchor — a draft precise time
 * belongs to the composer, and survives a refresh because nothing here owns
 * it.
 *
 * Pure: no React, no DOM, no storage, no database. The caller supplies the
 * clock, so every transition is tested without waiting.
 */

/** `MediaError.MEDIA_ERR_NETWORK`, named once here so nothing else does. */
export const MEDIA_ERR_NETWORK = 2;

/** What a failing element said, reduced to what the rule needs. */
export type MediaFailure = {
  /** `element.error?.code`, or null when there is none to read. */
  code: number | null;
  /** Whether this source had reached `HAVE_METADATA` before it failed. */
  hadMetadata: boolean;
};

/** Why automatic recovery stopped. Never shown as a code; F6.2 chooses words. */
export type FailReason =
  /** Not a failure a fresh URL can fix: before metadata, or not a network error. */
  | "not_recoverable"
  /** A second network failure inside the window: not expiry. */
  | "window"
  /** The fresh source, or the restore after it, failed too. */
  | "refresh_failed";

export type RecoveryState =
  /** Playing or paused as the person left it. `lastRefreshAt` opens the window. */
  | { phase: "ready"; lastRefreshAt: number | null }
  /** A fresh source is being fetched through our route. */
  | { phase: "refreshing"; resumeAt: number; lastRefreshAt: number }
  /** The fresh source has its metadata; the time is being put back. */
  | { phase: "restoring"; resumeAt: number; lastRefreshAt: number }
  /** Stopped. Nothing automatic happens again for this element. */
  | { phase: "failed"; reason: FailReason; lastRefreshAt: number | null };

export type RecoveryEvent =
  /** The element errored. `at` is its `currentTime` then; `now` is the clock. */
  | { type: "error"; failure: MediaFailure; at: number; now: number }
  /** The fresh source reached its metadata. */
  | { type: "metadata" }
  /** The time was put back. */
  | { type: "restored" }
  /** The fresh source took too long. */
  | { type: "timeout" }
  /** A person asked to try again (F6.2's *Try again*). `at` is where to resume. */
  | { type: "retry"; at: number; now: number };

/** What the caller must do now. `restore` can only ever say paused. */
export type RecoveryAction =
  | { type: "none" }
  /** Point the element at a fresh `/view` request. */
  | { type: "refresh" }
  /** Seek to `seek` and leave it paused. Never play. */
  | { type: "restore"; seek: number; playback: "paused" }
  /** Stop; say so calmly (F6.2). */
  | { type: "give_up"; reason: FailReason };

export type Step = { state: RecoveryState; action: RecoveryAction };

export const initialRecovery: RecoveryState = { phase: "ready", lastRefreshAt: null };

/** Whether a failure is one a fresh signed URL could fix at all. */
export function qualifies(failure: MediaFailure): boolean {
  return failure.hadMetadata && failure.code === MEDIA_ERR_NETWORK;
}

/** Whether the window opened by the last refresh has closed at `now`. */
export function windowOpen(lastRefreshAt: number | null, now: number, windowMs: number): boolean {
  return lastRefreshAt === null || now - lastRefreshAt >= windowMs;
}

const stay = (state: RecoveryState): Step => ({ state, action: { type: "none" } });

const giveUp = (reason: FailReason, lastRefreshAt: number | null): Step => ({
  state: { phase: "failed", reason, lastRefreshAt },
  action: { type: "give_up", reason },
});

/** A place in the media that can be sought: finite and not negative, else the start. */
const resumeFrom = (at: number): number => (Number.isFinite(at) && at > 0 ? at : 0);

/**
 * One event, and what follows from it. `windowMs` is the view URL's lifetime
 * in milliseconds — the effective TTL the page was served with.
 */
export function recover(state: RecoveryState, event: RecoveryEvent, windowMs: number): Step {
  switch (state.phase) {
    case "ready": {
      if (event.type !== "error") return stay(state);
      if (!qualifies(event.failure)) return giveUp("not_recoverable", state.lastRefreshAt);
      if (!windowOpen(state.lastRefreshAt, event.now, windowMs)) return giveUp("window", state.lastRefreshAt);
      return {
        state: { phase: "refreshing", resumeAt: resumeFrom(event.at), lastRefreshAt: event.now },
        action: { type: "refresh" },
      };
    }

    case "refreshing": {
      if (event.type === "metadata") {
        return {
          state: { phase: "restoring", resumeAt: state.resumeAt, lastRefreshAt: state.lastRefreshAt },
          action: { type: "restore", seek: state.resumeAt, playback: "paused" },
        };
      }
      if (event.type === "error" || event.type === "timeout") return giveUp("refresh_failed", state.lastRefreshAt);
      return stay(state);
    }

    case "restoring": {
      if (event.type === "restored") return stay({ phase: "ready", lastRefreshAt: state.lastRefreshAt });
      if (event.type === "error" || event.type === "timeout") return giveUp("refresh_failed", state.lastRefreshAt);
      return stay(state);
    }

    case "failed": {
      // Only a person starts another attempt, and it is theirs: no window.
      if (event.type !== "retry") return stay(state);
      return {
        state: { phase: "refreshing", resumeAt: resumeFrom(event.at), lastRefreshAt: event.now },
        action: { type: "refresh" },
      };
    }
  }
}
