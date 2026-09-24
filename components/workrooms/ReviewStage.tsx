"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { containRect, fromFraction } from "@/lib/workrooms/anchor-geometry";
import { formatDuration } from "@/lib/workrooms/anchor-label";
import { seekPlan } from "@/lib/workrooms/review-locator";
import type { ClientAnchor } from "@/lib/workrooms/review-view";
import styles from "@/components/workrooms/ReviewStage.module.css";

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
 */

type Active = { n: number; subject: number; anchor: ClientAnchor };

/** One locator's request: the note, its block and precision, and its block's name. */
export type LocatorRequest = Active & { name: string };

type Stage = {
  active: Active | null;
  register: (position: number, element: HTMLElement) => () => void;
  activate: (request: LocatorRequest) => void;
  /** Clears everything, or only note `n` if that is what is showing. */
  clear: (n?: number) => void;
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
    [show, stop],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A dialog takes Escape for itself; this is not the thing being closed.
      if (document.querySelector("dialog[open]")) return;
      clear();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      stop();
    };
  }, [clear, stop]);

  const stage = useMemo<Stage>(
    () => ({ active, register, activate, clear }),
    [active, register, activate, clear],
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

  return (
    // Focusable by script only, so a locator can hand focus to the work it
    // brought into view; never a tab stop of its own.
    <div ref={box} className={styles.target} tabIndex={-1}>
      {children}
      {point ? <Marker box={box} x={point.x} y={point.y} /> : null}
    </div>
  );
}

const px = (value: string): number => Number.parseFloat(value) || 0;

/**
 * The point, on the picture — **placed through the content rectangle, never
 * against the page.**
 *
 * The image's content box is its bounding rectangle less its own border and
 * padding; F1's `containRect` fits the intrinsic aspect ratio inside it, the
 * way `object-fit: contain; object-position: 50% 50%` does; and the fraction
 * is placed in *that*. Then, and only then, it is expressed relative to this
 * block, which is what the marker is positioned in. Measured again whenever
 * the image or the block changes size, so a rotation or a resize moves it with
 * the work.
 */
function Marker({ box, x, y }: { box: RefObject<HTMLDivElement | null>; x: number; y: number }) {
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const block = box.current;
    const image = block?.querySelector("img");
    if (!block || !image) return;

    const place = () => {
      if (!image.naturalWidth || !image.naturalHeight) return setAt(null);

      const style = window.getComputedStyle(image);
      const rect = image.getBoundingClientRect();
      const left = px(style.borderLeftWidth) + px(style.paddingLeft);
      const right = px(style.borderRightWidth) + px(style.paddingRight);
      const top = px(style.borderTopWidth) + px(style.paddingTop);
      const bottom = px(style.borderBottomWidth) + px(style.paddingBottom);

      const content = containRect(
        { width: image.naturalWidth, height: image.naturalHeight },
        { left: rect.left + left, top: rect.top + top, width: rect.width - left - right, height: rect.height - top - bottom },
      );
      const spot = content ? fromFraction({ x, y }, content) : null;
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
