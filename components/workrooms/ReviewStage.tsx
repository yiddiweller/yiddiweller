"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import type { Rect, Size } from "@/lib/workrooms/anchor-geometry";
import { formatDuration } from "@/lib/workrooms/anchor-label";
import {
  beginPoint,
  isArrowKey,
  nudgePoint,
  placePoint,
  pointOnImage,
  pointSummary,
  type PointCandidate,
} from "@/lib/workrooms/point-capture";
import {
  beginCapture,
  candidateLabel,
  captureSummary,
  noticeText,
  rangesOffered,
  serializeAnchor,
  takeEnd,
  takeMoment,
  takeStart,
  type CaptureState,
  type TimeCandidate,
} from "@/lib/workrooms/time-capture";
import { seekPlan } from "@/lib/workrooms/review-locator";
import type { ClientAnchor } from "@/lib/workrooms/review-view";
import styles from "@/components/workrooms/ReviewStage.module.css";
import thread from "@/components/workrooms/ReviewThread.module.css";

/**
 * Where a Review meets the work it is about — **the one client island Stage F
 * adds**, and deliberately a small one.
 *
 * `PresentationView` and `ReviewThread` stay server components. This wraps
 * both on the four pages that show a Revision beside its own round, and holds
 * only what a browser has to: which blocks are on screen, keyed by their
 * **position in this Revision**; which one note is being shown; and a pending
 * seek. It never holds an identifier, a signed address, a Review's state or a
 * rule about who may do what — the page's projection already decided what may
 * be drawn, and every one of those decisions was made on the server.
 *
 * **Nothing happens because feedback is on screen.** The work stays clean
 * until somebody presses a locator; then that one block is scrolled to, and a
 * point is drawn or a player is paused at a moment. Pressing another replaces
 * it, pressing the same one again or Escape clears it, and leaving the page
 * takes it with it. There is never more than one.
 *
 * Outside a stage every piece of this is inert: `AnchorTarget` renders its
 * children untouched, so the Files pages, Preview and any page without a round
 * render exactly the markup they always did.
 *
 * **Stage F3 adds capture, and nothing else.** The one root comment being
 * written may open a **capture session** on the recording or video it is about:
 * a small panel under that block's own native player that reads where the
 * player is. F4.1 opens the same panel under a video's player, not a second one.
 * The session is the composer's, not the stage's — the stage only knows which
 * block it is on and whom to answer when it ends — and it is one more context
 * of the same kind: opening it puts away any locator's, and a locator pressed
 * meanwhile cancels it. Once a comment is sent, showing its time again is F2's
 * job, done by F2's code.
 *
 * **Stage F5.2 adds a point, in the same session.** A capture is of a `time`
 * or of a `point`; a point capture turns **the image's own stage** — the
 * element `FileViewer` draws the picture in, and nothing around it — into the
 * one surface a press can place a point on, for as long as the session is
 * open. The panel, its buttons, the composer, *Download original* and every
 * link are outside that surface, so nothing pressed there is ever a point or a
 * press beside the picture. Every number is F5.1's: the page measures, the
 * rules decide, and F2's one marker draws the draft.
 */

type Active = { n: number; subject: number; anchor: ClientAnchor };

/** One locator's request: the note, its block and precision, and its block's name. */
export type LocatorRequest = Active & { name: string };

/** Anything the composer's one precision control can hold: a time or a point. */
export type Candidate = TimeCandidate | PointCandidate;

/**
 * One capture, opened by the composer for the block its comment is about.
 * `initial` is the draft's current choice, so *Change* then *Cancel* gives it
 * back untouched; `done` and `cancel` are how the composer hears the result.
 */
export type CaptureSession = {
  owner: symbol;
  /** What is being chosen: a time in a player, or a point on a picture. */
  kind: "time" | "point";
  subject: number;
  name: string;
  initial: Candidate | null;
  done: (anchor: Candidate) => void;
  cancel: () => void;
  /** Stamped by the stage, so each opening starts a fresh panel. */
  serial?: number;
};

type Stage = {
  active: Active | null;
  register: (position: number, element: HTMLElement) => () => void;
  activate: (request: LocatorRequest) => void;
  /** Clears everything, or only note `n` if that is what is showing. */
  clear: (n?: number) => void;
  capture: CaptureSession | null;
  openCapture: (session: CaptureSession) => void;
  /** Done with a candidate, or Cancel with null. Answers the composer. */
  endCapture: (anchor: Candidate | null) => void;
  /** Closes the owner's session without answering — its subject changed. */
  abandonCapture: (owner: symbol) => void;
};

const StageContext = createContext<Stage | null>(null);

/** How long a player may take to say how long it is before a seek gives up. */
const METADATA_TIMEOUT_MS = 10_000;
/** How long a locator waits for its block to be on the page at all. */
const TARGET_TIMEOUT_MS = 1_000;

const HAVE_METADATA = 1;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Focus without a second, competing scroll. */
function focusQuietly(element: HTMLElement | null): boolean {
  if (!element) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

/**
 * Resolves true once the player knows its duration, false if it never does.
 *
 * Listeners are added and removed by hand, one pair per wait, and `cancel`
 * removes them too — so pressing a locator five times while a slow file loads
 * leaves one wait behind, not five.
 */
function whenMetadata(media: HTMLMediaElement): { ready: Promise<boolean>; cancel: () => void } {
  if (media.readyState >= HAVE_METADATA) return { ready: Promise.resolve(true), cancel: () => {} };
  if (media.error) return { ready: Promise.resolve(false), cancel: () => {} };

  let settle: (value: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });

  const onReady = () => finish(true);
  const onError = () => finish(false);
  const timer = window.setTimeout(() => finish(false), METADATA_TIMEOUT_MS);

  function finish(value: boolean) {
    window.clearTimeout(timer);
    media.removeEventListener("loadedmetadata", onReady);
    media.removeEventListener("error", onError);
    settle(value);
  }

  media.addEventListener("loadedmetadata", onReady);
  media.addEventListener("error", onError);

  return { ready, cancel: () => finish(false) };
}

export function ReviewStage({ children }: { children: ReactNode }) {
  const targets = useRef(new Map<number, HTMLElement>());
  const [active, setActive] = useState<Active | null>(null);
  const [message, setMessage] = useState("");

  // What is showing, readable synchronously by the handlers below.
  const current = useRef<Active | null>(null);
  // Bumped by every activation and every clear; an older operation that wakes
  // up to find a newer number stops where it is.
  const generation = useRef(0);
  const pending = useRef<(() => void) | null>(null);

  const show = useCallback((next: Active | null) => {
    current.current = next;
    setActive(next);
  }, []);

  const stop = useCallback(() => {
    generation.current += 1;
    pending.current?.();
    pending.current = null;
  }, []);

  const clear = useCallback(
    (n?: number) => {
      if (n !== undefined && current.current?.n !== n) return;
      if (current.current === null && pending.current === null) return;
      stop();
      show(null);
      setMessage("");
    },
    [show, stop],
  );

  // The one capture session, if the composer has opened one.
  const [capture, setCapture] = useState<CaptureSession | null>(null);
  const session = useRef<CaptureSession | null>(null);
  const serial = useRef(0);

  const setSession = useCallback((next: CaptureSession | null) => {
    session.current = next;
    setCapture(next);
  }, []);

  const endCapture = useCallback(
    (anchor: Candidate | null) => {
      const open = session.current;
      if (!open) return;
      setSession(null);
      if (anchor) {
        setMessage(
          anchor.kind === "point"
            ? `${pointSummary(open.name)} is set.`
            : `Precise time set: ${candidateLabel(anchor) ?? ""}.`,
        );
        open.done(anchor);
      } else {
        setMessage(open.kind === "point" ? "The point was left as it was." : "The precise time was left as it was.");
        open.cancel();
      }
    },
    [setSession],
  );

  const abandonCapture = useCallback(
    (owner: symbol) => {
      if (session.current?.owner === owner) setSession(null);
    },
    [setSession],
  );

  const openCapture = useCallback(
    (next: CaptureSession) => {
      // One context: a point or a paused moment being shown is put away.
      stop();
      show(null);

      const element = targets.current.get(next.subject);
      if (!element?.isConnected) {
        setSession(null);
        setMessage(`${next.name} is not shown on this page.`);
        next.cancel();
        return;
      }

      serial.current += 1;
      setSession({ ...next, serial: serial.current });
      setMessage("");
      element.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    },
    [setSession, show, stop],
  );

  const register = useCallback((position: number, element: HTMLElement) => {
    targets.current.set(position, element);
    return () => {
      if (targets.current.get(position) === element) targets.current.delete(position);
      // The block went — so does anything drawn on it.
      if (current.current?.subject === position) {
        current.current = null;
        setActive(null);
      }
    };
  }, []);

  const activate = useCallback(
    (request: LocatorRequest) => {
      // Showing a sent note's place ends any capture still open: one context.
      if (session.current) endCapture(null);
      stop();
      const mine = generation.current;
      const stale = () => generation.current !== mine;

      const { n, subject, anchor, name } = request;
      const started = performance.now();

      // The block is normally registered long before anybody can press
      // anything; this covers a page that activates a note as it loads.
      const find = (): Promise<HTMLElement | null> =>
        new Promise((resolve) => {
          const look = () => {
            if (stale()) return resolve(null);
            const element = targets.current.get(subject);
            if (element?.isConnected) return resolve(element);
            if (performance.now() - started > TARGET_TIMEOUT_MS) return resolve(null);
            window.requestAnimationFrame(look);
          };
          look();
        });

      void (async () => {
        const element = await find();
        if (stale()) return;

        if (!element) {
          show(null);
          setMessage(`${name} is not shown on this page.`);
          return;
        }

        show({ n, subject, anchor });
        element.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });

        if (anchor.kind !== "time") {
          focusQuietly(element);
          // A region is stored and readable, but nothing draws one yet — so
          // this shows the block and says no more than that.
          setMessage(anchor.kind === "point" ? `Showing the point on ${name}.` : `Showing ${name}.`);
          return;
        }

        const media = element.querySelector<HTMLMediaElement>("video, audio");
        if (!media) {
          focusQuietly(element);
          setMessage(`${name} cannot be played here.`);
          return;
        }

        // Paused first and paused after. Nothing here ever calls play().
        media.pause();
        if (!focusQuietly(media)) focusQuietly(element);

        const wait = whenMetadata(media);
        pending.current = wait.cancel;
        const ready = await wait.ready;
        if (stale()) return;
        pending.current = null;

        if (!ready) {
          setMessage(`${name} could not be loaded here.`);
          return;
        }

        const plan = seekPlan(anchor, media.duration);
        if (!plan) return;
        if ("beyond" in plan) {
          setMessage(`${name} ends before ${formatDuration(anchor.t) ?? "that moment"}.`);
          return;
        }

        media.pause();
        media.currentTime = plan.seek;
        setMessage(`${name}, paused at ${formatDuration(plan.seek) ?? "that moment"}.`);
      })();
    },
    [endCapture, show, stop],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog takes Escape for itself; this is not the thing being closed.
      if (document.querySelector("dialog[open]")) return;
      // While a time is being chosen, Escape is that panel's Cancel.
      if (session.current) return endCapture(null);
      clear();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stop();
    };
  }, [clear, endCapture, stop]);

  const stage = useMemo<Stage>(
    () => ({ active, register, activate, clear, capture, openCapture, endCapture, abandonCapture }),
    [active, register, activate, clear, capture, openCapture, endCapture, abandonCapture],
  );

  return (
    <StageContext.Provider value={stage}>
      {children}
      <p className={styles.announce} role="status" aria-live="polite">
        {message}
      </p>
    </StageContext.Provider>
  );
}

/**
 * One presented file, findable by its position in the Revision.
 *
 * Outside a stage it is nothing at all — the children, untouched — which is
 * what keeps the one `FileViewer` exactly as it was everywhere a Review is not.
 */
export function AnchorTarget({ position, children }: { position: number; children: ReactNode }) {
  const stage = useContext(StageContext);
  if (!stage) return <>{children}</>;
  return (
    <Target stage={stage} position={position}>
      {children}
    </Target>
  );
}

function Target({ stage, position, children }: { stage: Stage; position: number; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const { register } = stage;

  useEffect(() => {
    if (!box.current) return;
    return register(position, box.current);
  }, [register, position]);

  const point =
    stage.active?.subject === position && stage.active.anchor.kind === "point"
      ? stage.active.anchor
      : null;

  const capturing = stage.capture?.subject === position ? stage.capture : null;

  return (
    // Focusable by script only, so a locator can hand focus to the work it
    // brought into view; never a tab stop of its own.
    <div ref={box} className={styles.target} tabIndex={-1}>
      {children}
      {point ? <Marker box={box} x={point.x} y={point.y} /> : null}
      {capturing?.kind === "point" ? (
        <PointCapture key={capturing.serial} box={box} session={capturing} end={stage.endCapture} />
      ) : capturing ? (
        <CapturePanel key={capturing.serial} box={box} session={capturing} end={stage.endCapture} />
      ) : null}
    </div>
  );
}

const px = (value: string): number => Number.parseFloat(value) || 0;

/**
 * The picture's content box, measured: its bounding rectangle less its own
 * border and padding, in the same CSS pixel space a pointer event reports.
 * Measuring only — what the box *means* is `point-capture.ts`'s to decide.
 */
function contentBox(image: HTMLImageElement): Rect {
  const style = window.getComputedStyle(image);
  const rect = image.getBoundingClientRect();
  const left = px(style.borderLeftWidth) + px(style.paddingLeft);
  const right = px(style.borderRightWidth) + px(style.paddingRight);
  const top = px(style.borderTopWidth) + px(style.paddingTop);
  const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);
  return { left: rect.left + left, top: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom };
}

/** The picture's own size, as the browser decoded it — after EXIF orientation. */
const natural = (image: HTMLImageElement): Size => ({ width: image.naturalWidth, height: image.naturalHeight });

/**
 * The point, on the picture — **placed through the content rectangle, never
 * against the page.**
 *
 * The image's content box is its bounding rectangle less its own border and
 * padding; `pointOnImage` — F1's `containRect` then `fromFraction` — fits the
 * intrinsic aspect ratio inside it, the way `object-fit: contain;
 * object-position: 50% 50%` does, and places the fraction in *that*. Then, and
 * only then, it is expressed relative to this block, which is what the marker
 * is positioned in. Measured again whenever the image or the block changes
 * size, so a rotation or a resize moves it with the work.
 *
 * The one marker, for a locator's point (F2) and for a point being chosen (F5).
 */
function Marker({ box, x, y }: { box: RefObject<HTMLDivElement | null>; x: number; y: number }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const block = box.current;
    const image = block?.querySelector("img");
    if (!block || !image) return;

    const place = () => {
      const spot = pointOnImage({ x, y }, natural(image), contentBox(image));
      if (!spot) return setAt(null);

      const origin = block.getBoundingClientRect();
      setAt({ left: spot.x - origin.left, top: spot.y - origin.top });
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(image);
    observer.observe(block);
    image.addEventListener("load", place);
    return () => {
      observer.disconnect();
      image.removeEventListener("load", place);
    };
  }, [box, x, y]);

  if (!at) return null;

  return (
    <span
      className={styles.marker}
      style={{ left: at.left, top: at.top }}
      aria-hidden="true"
      data-anchor-marker=""
    />
  );
}

/**
 * The control a precise note carries: *On The board · Point*, *On The motion ·
 * At 0:42*.
 *
 * A real button, named by its own words, pressed to show and pressed again to
 * put away — which is the explicit *hide* a touch screen needs, since it has
 * no Escape key. Its state is `aria-pressed`, so whether the point is showing
 * is said rather than only drawn.
 */
export function ReviewLocator({
  className,
  n,
  subject,
  anchor,
  name,
  label,
  activateOnLoad = false,
}: {
  className: string;
  n: number;
  subject: number;
  anchor: ClientAnchor;
  /** The block's name, for what is announced. */
  name: string;
  label: string;
  /** Set only when the page was opened *for* this note, from a deliberate link. */
  activateOnLoad?: boolean;
}) {
  const stage = useContext(StageContext);
  const activate = stage?.activate;
  const clear = stage?.clear;
  const opened = useRef(false);

  useEffect(() => {
    if (!activateOnLoad || opened.current || !activate) return;
    opened.current = true;
    activate({ n, subject, anchor, name });
  }, [activateOnLoad, activate, n, subject, anchor, name]);

  // A note that stops being on the page takes what it showed with it.
  useEffect(() => () => clear?.(n), [clear, n]);

  if (!stage) return <span className={className}>{label}</span>;

  const pressed = stage.active?.n === n;

  return (
    <button
      type="button"
      className={className}
      aria-pressed={pressed}
      onClick={() => (pressed ? stage.clear() : stage.activate({ n, subject, anchor, name }))}
    >
      {label}
    </button>
  );
}

/* ------------------------------------------------------------ F3: capture */

type Player = { duration: number; current: number; failed: boolean };

/** The one native player a block holds — a video's or a recording's. */
const PLAYER = "video, audio";

function readPlayer(media: HTMLMediaElement | null): Player {
  if (!media) return { duration: Number.NaN, current: 0, failed: true };
  return { duration: media.duration, current: media.currentTime, failed: media.error !== null };
}

/**
 * The panel under a recording or a video while somebody chooses a time in it.
 *
 * **It reads the native player and nothing else.** No waveform, no scrubber,
 * no second player: the browser's own controls are how a person gets to the
 * place they mean, and these buttons only record where that is. Each press
 * goes through the pure rules in `time-capture.ts`, so the panel can only
 * ever hold a moment inside the file or a stretch that ends after it starts.
 *
 * Unavailable — with the reason said, not implied — until the file reports a
 * finite duration, and for good if it cannot load: ordinary feedback about the
 * file is unaffected either way.
 *
 * **The block's own player, whichever it is.** A video's `<video>` or a
 * recording's `<audio>` — the one element inside this block — is read as it
 * is at every press, so a video scrubbed in native fullscreen and brought back
 * inline is read where it was left. Nothing is mirrored into a timeline.
 */
function CapturePanel({
  box,
  session,
  end,
}: {
  box: RefObject<HTMLDivElement | null>;
  session: CaptureSession;
  end: (anchor: TimeCandidate | null) => void;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useId();
  // The panel only ever mounts after a press, in a browser, inside a block
  // that is already on the page — so the player can be read as it opens.
  const media = (): HTMLMediaElement | null => box.current?.querySelector<HTMLMediaElement>(PLAYER) ?? null;
  const [state, setState] = useState<CaptureState>(() => beginCapture(session.initial));
  const [player, setPlayer] = useState<Player>(() => readPlayer(media()));
  const [ranges] = useState(() => rangesOffered(window.matchMedia("(pointer: coarse)").matches));

  useEffect(() => {
    const element = box.current?.querySelector<HTMLMediaElement>(PLAYER);
    if (!element) return;
    const update = () => setPlayer(readPlayer(element));
    const events = ["loadedmetadata", "durationchange", "timeupdate", "seeked", "error"] as const;
    for (const event of events) element.addEventListener(event, update);
    return () => {
      for (const event of events) element.removeEventListener(event, update);
    };
  }, [box]);

  // Focus arrives here only because somebody pressed *Set precise time*.
  useEffect(() => {
    panel.current?.focus({ preventScroll: true });
  }, []);

  const ready = !player.failed && Number.isFinite(player.duration) && player.duration > 0;
  const press = (take: typeof takeMoment) => () => {
    const now = readPlayer(media());
    setState((previous) => take(previous, now.current, now.duration));
  };

  const reason = !media()
    ? "This block cannot take a precise time."
    : player.failed
      ? "This file could not be loaded here, so a precise time cannot be set. Your feedback can still be about it as a whole."
      : ready
        ? null
        : noticeText("not_ready");

  return (
    <div
      ref={panel}
      className={`${styles.capture} ${thread.sizes}`}
      role="group"
      aria-labelledby={heading}
      tabIndex={-1}
    >
      <p id={heading} className={styles.captureTitle}>
        {`Precise time on ${session.name}`}
      </p>
      <p className={styles.captureHint}>
        {ranges
          ? "Play or move the player above to the place you mean, then choose a moment — or a start and an end."
          : "Play or move the player above to the place you mean, then choose the moment."}
      </p>

      {reason ? (
        <p className={styles.captureHint} role="status">
          {reason}
        </p>
      ) : (
        <p className={styles.captureNow}>{`Player at ${formatDuration(player.current) ?? "0:00"}`}</p>
      )}

      <div className={thread.controls}>
        <button type="button" className={styles.captureAction} disabled={!ready} onClick={press(takeMoment)}>
          Use this moment
        </button>
        {ranges ? (
          <>
            <button type="button" className={styles.captureAction} disabled={!ready} onClick={press(takeStart)}>
              Start here
            </button>
            <button
              type="button"
              className={styles.captureAction}
              disabled={!ready || state.start === null}
              onClick={press(takeEnd)}
            >
              End here
            </button>
          </>
        ) : null}
      </div>

      {/* The choice in words, said as it changes, and any reason a press did
          not make one — so nobody has to read a time off a slider. */}
      <p className={styles.captureChoice} role="status" aria-live="polite">
        {state.notice && state.notice !== "not_ready" ? noticeText(state.notice) : captureSummary(state)}
      </p>

      <div className={thread.controls}>
        <button
          type="button"
          className={thread.button}
          disabled={state.candidate === null}
          onClick={() => state.candidate && end(state.candidate)}
        >
          Done
        </button>
        <button type="button" className={thread.buttonQuiet} onClick={() => end(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------- F5.2: a point */

/** Why a press on the picture's stage did not place a point. */
type PointNotice = "beside" | "not_ready";

/**
 * A point being chosen on a picture: its stage made the one surface a press
 * can land on, F2's marker on the draft, and a panel under it saying what is
 * held.
 *
 * **The surface is the image's own stage and nothing else** — the element
 * `FileViewer` draws the picture in (`img.parentElement`), which holds the
 * picture and any space around it and none of the controls. Its click and key
 * listeners exist only while this session is open, and they are native
 * listeners on that element, so a press anywhere else — Done, Cancel, the
 * composer, *Download original*, a link, the next block — never reaches them,
 * by bubbling or otherwise. A press on the stage that is not on the picture is
 * refused and said, and a point already chosen stays where it was.
 *
 * `click`, not `pointerdown`: a phone does not fire one for a scroll, so the
 * page scrolls under a finger exactly as it always does, and nothing here ever
 * prevents a touch. While it is open the picture cannot be dragged, selected
 * or long-pressed into a menu, and the stage takes focus so the arrow keys can
 * place a point too — F5.1's `nudgePoint`: the first puts it in the middle,
 * each moves it a little, Shift further, and Enter keeps it. Escape is the
 * stage's, as for every capture: Cancel.
 */
function PointCapture({
  box,
  session,
  end,
}: {
  box: RefObject<HTMLDivElement | null>;
  session: CaptureSession;
  end: (anchor: Candidate | null) => void;
}) {
  const heading = useId();
  const instructions = useId();
  const [point, setPoint] = useState<PointCandidate | null>(() => beginPoint(session.initial));
  const [notice, setNotice] = useState<PointNotice | null>(null);
  const [touch] = useState(() => window.matchMedia("(pointer: coarse)").matches);
  const verb = touch ? "tap" : "click";
  const { name } = session;

  // The stage, made a surface for as long as this session is open — and
  // given back exactly as it was when it closes.
  useEffect(() => {
    const image = box.current?.querySelector("img");
    const surface = image?.parentElement;
    if (!image || !surface) return;

    const draggable = image.draggable;
    image.draggable = false;
    surface.classList.add(styles.pointSurface);
    surface.tabIndex = 0;
    surface.setAttribute("role", "application");
    surface.setAttribute("aria-label", `Place a point on ${name}`);
    surface.setAttribute("aria-describedby", instructions);
    surface.focus({ preventScroll: true });

    return () => {
      image.draggable = draggable;
      surface.classList.remove(styles.pointSurface);
      surface.removeAttribute("tabindex");
      surface.removeAttribute("role");
      surface.removeAttribute("aria-label");
      surface.removeAttribute("aria-describedby");
    };
  }, [box, name, instructions]);

  // What a press on that surface does. Re-attached as the point changes, so
  // Enter always keeps the point that is showing.
  useEffect(() => {
    const image = box.current?.querySelector("img");
    const surface = image?.parentElement;
    if (!image || !surface) return;

    const onClick = (event: MouseEvent) => {
      if (!image.naturalWidth || !image.naturalHeight) return setNotice("not_ready");
      const placed = placePoint({ x: event.clientX, y: event.clientY }, natural(image), contentBox(image));
      if (!placed) return setNotice("beside");
      setPoint(placed);
      setNotice(null);
    };

    const onKey = (event: KeyboardEvent) => {
      if (isArrowKey(event.key)) {
        // The arrows move the point, not the page.
        event.preventDefault();
        const key = event.key;
        setPoint((previous) => nudgePoint(previous, key, event.shiftKey));
        setNotice(null);
      } else if (event.key === "Enter" && point) {
        event.preventDefault();
        end(point);
      }
    };

    surface.addEventListener("click", onClick);
    surface.addEventListener("keydown", onKey);
    return () => {
      surface.removeEventListener("click", onClick);
      surface.removeEventListener("keydown", onKey);
    };
  }, [box, point, end]);

  const status =
    notice === "beside"
      ? `That is beside the image — ${verb} the picture itself.`
      : notice === "not_ready"
        ? "Available once the image has loaded."
        : point
          ? `Point placed — ${verb} again to move it.`
          : "Nothing chosen yet.";

  return (
    <>
      {point ? <Marker box={box} x={point.x} y={point.y} /> : null}
      <div className={`${styles.capture} ${thread.sizes}`} role="group" aria-labelledby={heading}>
        <p id={heading} className={styles.captureTitle}>
          {`Point on ${name}`}
        </p>
        <p className={styles.captureHint}>{touch ? "Tap the image where you mean." : "Click the image where you mean."}</p>
        <p id={instructions} className={styles.announce}>
          Or, with the picture focused, use the arrow keys: the first puts a point in the middle, each moves it a
          little, Shift moves it further, and Enter keeps it.
        </p>
        {/* The choice in words, never numbers, and why a press did not make one. */}
        <p className={styles.captureChoice} role="status" aria-live="polite">
          {status}
        </p>
        <div className={thread.controls}>
          <button type="button" className={thread.button} disabled={point === null} onClick={() => point && end(point)}>
            Done
          </button>
          <button type="button" className={thread.buttonQuiet} onClick={() => end(null)}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * The composer's half of capture: *Set precise time* for a recording or a
 * video, *Point to it* for a picture (F5.2), and the choice once made — *At
 * 0:42*, *A point on The board* — with *Change* and *Clear*.
 *
 * The anchor lives in the unsent draft and travels in the form's own `anchor`
 * field when it is sent, through the same action, reader, parser and domain as
 * everything else. Nothing here stores it anywhere else, and the server judges
 * it again from scratch.
 */
export function PrecisionControl({
  kind,
  subject,
  name,
  draft,
  onDraft,
  composer,
}: {
  /** What this block takes: a time, or a point. */
  kind: "time" | "point";
  subject: number;
  name: string;
  draft: Candidate | null;
  onDraft: (anchor: Candidate | null) => void;
  /** Where focus goes when a chosen time comes back: the words being written. */
  composer: RefObject<HTMLTextAreaElement | null>;
}) {
  const stage = useContext(StageContext);
  const opener = useRef<HTMLButtonElement>(null);
  const [owner] = useState(() => Symbol("capture"));
  const abandon = stage?.abandonCapture;

  // The composer going away takes its unfinished capture with it.
  useEffect(() => () => abandon?.(owner), [abandon, owner]);

  if (!stage) return null;

  const back = (target: HTMLElement | null) => {
    if (!target) return;
    target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
    target.focus({ preventScroll: true });
  };

  const open = () =>
    stage.openCapture({
      owner,
      kind,
      subject,
      name,
      initial: draft,
      done: (anchor) => {
        onDraft(anchor);
        back(composer.current);
      },
      cancel: () => back(opener.current),
    });

  const capturing = stage.capture?.owner === owner;
  const point = kind === "point";
  const chosen = point ? (draft?.kind === "point" ? pointSummary(name) : null) : candidateLabel(draft);
  const what = point ? "the point" : "the precise time";

  return (
    <div className={styles.precision}>
      {chosen ? (
        <>
          <span className={styles.precisionChoice}>{chosen}</span>
          <button
            ref={opener}
            type="button"
            className={thread.buttonQuiet}
            aria-label={`Change ${what} on ${name}`}
            aria-expanded={capturing}
            onClick={open}
          >
            Change
          </button>
          <button
            type="button"
            className={thread.buttonQuiet}
            aria-label={`Clear ${what} on ${name}`}
            onClick={() => onDraft(null)}
          >
            Clear
          </button>
        </>
      ) : (
        <button
          ref={opener}
          type="button"
          className={thread.buttonQuiet}
          aria-label={point ? `Point to a place on ${name}` : `Set precise time on ${name}`}
          aria-expanded={capturing}
          onClick={open}
        >
          {point ? "Point to it" : "Set precise time"}
        </button>
      )}
      {/* The draft's anchor, in the form, and nowhere else. */}
      <input type="hidden" name="anchor" value={serializeAnchor(draft)} />
    </div>
  );
}
