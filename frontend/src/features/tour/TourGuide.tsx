"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { buttonClass } from "@/components/ui/Button";
import { NebDot } from "@/components/ui/NebDot";

import { isDesktop, screenCoachForOnboarding } from "../desktop/bridge";
import { SCREEN_EVENTS } from "../screen/events";
import { TOUR_SIGNAL_EVENT, type TourSignal } from "./signals";
import { hrefOf, placeOf, stepsFor, type TourPlace, type TourStep } from "./steps";
import { useTour } from "./store";

const TICK_MS = 250;
const COACH_POLL_MS = 1500;
const BUBBLE_WIDTH = 340;
/** Room between the card and the control, for the arrow. */
const GAP = 46;
const EDGE = 16;
/** Something the desktop app sends this page once Screen Coach has taken a question. */
const SCREEN_ASKED = [
  SCREEN_EVENTS.release,
  SCREEN_EVENTS.answer,
  SCREEN_EVENTS.say,
  SCREEN_EVENTS.entrySaved,
] as const;

type Box = { top: number; left: number; width: number; height: number };
/** What the guide last saw of the app; `way`: the box is the way to the step's place. */
type Seen = { place: TourPlace | null; box: Box | null; dialogs: number; way: boolean };

const PLACE_NAMES: Record<TourPlace, string> = {
  desk: "your desk",
  home: "the notebook",
  page: "the page",
  review: "Review",
};

const noChange = () => () => undefined;

/**
 * The guided tour (docs/NEB_APP_UI.md decision U32): a small card from neb that sits over the
 * real app, rings the real control to press, and moves on when the student has done the thing.
 * It never clicks for them and never blocks the app: everything stays usable around it.
 */
export function TourGuide() {
  const mounted = useSyncExternalStore(
    noChange,
    () => true,
    () => false,
  );
  const desktop = useSyncExternalStore(noChange, isDesktop, () => false);
  const stepId = useTour((s) => s.stepId);
  if (!mounted || !stepId) return null;
  const steps = stepsFor(desktop);
  const index = steps.findIndex((s) => s.id === stepId);
  const step = steps[index];
  // A step this app doesn't have (the tour was started in the Windows app): nothing to show.
  if (!step) return null;
  return <Guide key={step.id} step={step} index={index} total={steps.length} desktop={desktop} />;
}

function look(step: TourStep): Seen {
  const place = placeOf(window.location.pathname, window.location.search);
  const dialogs = document.querySelectorAll("dialog[open]").length;
  let box: Box | null = null;
  const here = !step.place || step.place === place;
  // Elsewhere, the app's own way to the step's place, if it has one from here.
  const way = !here && place ? step.ways?.[place] : undefined;
  const target = here ? step.target : way?.target;
  if (target) {
    for (const element of document.querySelectorAll(target)) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      box = {
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      break;
    }
  }
  return { place, box, dialogs, way: way !== undefined && box !== null };
}

/** Whether anything matching `selector` is showing. */
function onScreen(selector: string): boolean {
  for (const element of document.querySelectorAll(selector)) {
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
  }
  return false;
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

function Guide({
  step,
  index,
  total,
  desktop,
}: {
  step: TourStep;
  index: number;
  total: number;
  desktop: boolean;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState<Seen>({ place: null, box: null, dialogs: 0, way: false });
  const [height, setHeight] = useState(220);
  /** A paced step's thing has been done: its button is free. */
  const [ready, setReady] = useState(false);
  const { advance, back, end } = useTour.getState();
  const next = () => advance(step.id, desktop);
  const skip = () => {
    const to = step.skipTo;
    if (to && stepsFor(desktop).some((s) => s.id === to)) useTour.getState().skip(step.id, to);
    else next();
  };

  // Watch the real app: where the student is, where the control is, whether they got there.
  useEffect(() => {
    const tick = () => {
      const now = look(step);
      const params = new URLSearchParams(window.location.search);
      useTour.getState().visited({
        ...(now.place === "home" && { nodeId: params.get("node") }),
        ...(now.place === "page" && { pageId: params.get("page") }),
      });
      const done = step.done;
      if (
        (done.by === "place" && now.place !== null && done.places.includes(now.place)) ||
        (done.by === "present" && onScreen(done.selector))
      ) {
        useTour.getState().advance(step.id, desktop);
        return;
      }
      // A paced step whose button waits for something to show (a quiz's feedback).
      if (done.by === "next" && typeof done.after === "object" && onScreen(done.after.present)) {
        setReady(true);
      }
      setSeen((was) =>
        was.place === now.place &&
        was.dialogs === now.dialogs &&
        was.way === now.way &&
        sameBox(was.box, now.box)
          ? was
          : now,
      );
      const tall = bubble.current?.offsetHeight;
      if (tall) setHeight(tall);
    };
    const timer = window.setInterval(tick, TICK_MS);
    const first = window.setTimeout(tick, 0);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(first);
    };
  }, [step, desktop]);

  // What the app reports: a line written, the keys let go, a PDF in, a question asked on screen.
  // It either finishes the step, or frees the button of a step the student paces.
  const awaited =
    step.done.by === "signal"
      ? step.done.signal
      : step.done.by === "next"
        ? typeof step.done.after === "object"
          ? "sight"
          : (step.done.after ?? null)
        : null;
  const paced = step.done.by === "next";
  useEffect(() => {
    if (!awaited || awaited === "coach-on" || awaited === "sight") return;
    const happened = () => {
      if (paced) setReady(true);
      else useTour.getState().advance(step.id, desktop);
    };
    const onSignal = (event: Event) => {
      if ((event as CustomEvent<TourSignal>).detail === awaited) happened();
    };
    window.addEventListener(TOUR_SIGNAL_EVENT, onSignal);
    const screen = awaited === "screen-asked" ? SCREEN_ASKED : [];
    for (const name of screen) window.addEventListener(name, happened);
    return () => {
      window.removeEventListener(TOUR_SIGNAL_EVENT, onSignal);
      for (const name of screen) window.removeEventListener(name, happened);
    };
  }, [step, desktop, awaited, paced]);

  // Screen Coach is turned on in the Windows app's own settings: ask it, and keep asking.
  useEffect(() => {
    if (awaited !== "coach-on") return;
    let live = true;
    const ask = () =>
      void screenCoachForOnboarding(false).then((on) => {
        if (live) setReady(on === true);
      });
    ask();
    const timer = window.setInterval(ask, COACH_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [awaited]);

  // The top layer, so the card stays readable over the app's own dialogs (shown again when one
  // opens, which puts it back on top).
  useEffect(() => {
    const element = layer.current;
    if (!element?.showPopover) return;
    try {
      if (element.matches(":popover-open")) element.hidePopover();
      element.showPopover();
    } catch {
      // not supported here: the card still shows, under any open dialog
    }
  }, [seen.dialogs]);

  const elsewhere = step.place !== undefined && seen.place !== step.place;
  const made = useTour.getState();
  const there = elsewhere && step.place ? hrefOf(step.place, made) : null;
  // Elsewhere, only the way there is ringed.
  const box = elsewhere && !seen.way ? null : seen.box;
  const way = elsewhere && seen.way && seen.place ? step.ways?.[seen.place] : undefined;
  /** A paced step still waiting for its thing, and one whose thing is done. */
  const waiting = paced && awaited !== null && !ready;
  const waited = paced && awaited !== null && ready;
  const centred = step.id === "done";
  const position = centred ? null : place(box, height);

  return (
    <div
      ref={layer}
      popover="manual"
      className="pointer-events-none fixed inset-0 m-0 size-full max-h-none max-w-none overflow-visible border-0 bg-transparent p-0 text-ink"
      data-testid="tour-guide"
      data-step={step.id}
    >
      {box && (
        <div
          aria-hidden
          data-testid="tour-ring"
          className="tour-ring absolute rounded-[14px]"
          style={{
            top: box.top - 6,
            left: box.left - 6,
            width: box.width + 12,
            height: box.height + 12,
          }}
        />
      )}
      {box && position && <Arrow from={cardBox(position, height)} to={box} />}
      <div className={centred ? "absolute inset-0 grid place-items-center p-4" : "contents"}>
        <div
          ref={bubble}
          role="dialog"
          aria-label={`Tour, step ${index + 1} of ${total}: ${step.title}`}
          className={`tour-in pointer-events-auto flex max-w-full flex-col gap-2.5 rounded-[16px] border border-line bg-paper-hi shadow-sh-3 ${centred ? "w-[440px] p-6" : "absolute p-4"}`}
          style={position ? { ...position, width: cardBox(position, height).width } : undefined}
        >
          <div className="flex items-center gap-2.5">
            <NebDot state="watching" size={22} />
            <span className="neb-voice text-[13px]">
              step {index + 1} of {total}
            </span>
            <span className="flex-1" />
            <button
              type="button"
              onClick={end}
              className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              End tour
            </button>
          </div>
          <div aria-live="polite" className="flex flex-col gap-1.5">
            <h2 className={`font-serif leading-tight ${centred ? "text-[30px]" : "text-[22px]"}`}>
              {step.title}
            </h2>
            <p className="text-sm leading-relaxed text-ink/80">{step.body}</p>
            {step.note && !waited && (
              <p className="text-xs leading-relaxed text-muted">{step.note}</p>
            )}
            {waited && (
              <p className="text-xs font-medium text-neb-ink" data-testid="tour-ready">
                ✓ {awaited === "coach-on" ? "Screen Coach is on." : "Done."} Carry on when
                you&apos;re ready.
              </p>
            )}
            {elsewhere && step.place && (
              <p className="text-xs leading-relaxed text-neb-ink">
                This happens on {PLACE_NAMES[step.place]}.
                {way ? ` ${way.hint}` : !there && " Open a notebook from your desk to carry on."}
              </p>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => back(desktop)}
                className={buttonClass("quiet", { dense: true })}
              >
                Back
              </button>
            )}
            <span className="flex-1" />
            {(step.done.by !== "next" || waiting) && (
              <button
                type="button"
                onClick={skip}
                className="text-xs text-muted underline-offset-2 hover:text-ink hover:underline"
              >
                Skip this step
              </button>
            )}
            {there && !way && (
              <button
                type="button"
                // A full load: the notebook restores its place from the address (U29).
                onClick={() => window.location.assign(there)}
                className={buttonClass("ink", { dense: true })}
              >
                Take me there
              </button>
            )}
            {awaited === "coach-on" && waiting && (
              <button
                type="button"
                onClick={() => void screenCoachForOnboarding(true)}
                className={buttonClass("ink", { dense: true })}
              >
                Open its settings
              </button>
            )}
            {step.done.by === "next" && !elsewhere && !waiting && (
              <button type="button" onClick={next} className={buttonClass("neb", { dense: true })}>
                {step.done.label ?? "Next"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Where the card goes: under the ringed control, above it if there's no room, and in the bottom
 * right corner when there's nothing to point at or the control fills the screen (the page).
 */
export function place(
  box: Box | null,
  height: number,
  view = { width: window.innerWidth, height: window.innerHeight },
): { top: number; left: number } | { right: number; bottom: number } {
  const corner = { right: EDGE, bottom: EDGE };
  if (!box || box.height > view.height * 0.6) return corner;
  const width = Math.min(BUBBLE_WIDTH, view.width - EDGE * 2);
  const left = Math.max(
    EDGE,
    Math.min(box.left + box.width / 2 - width / 2, view.width - width - EDGE),
  );
  const below = box.top + box.height + GAP;
  if (below + height <= view.height - EDGE) return { top: below, left };
  const above = box.top - GAP - height;
  return above >= EDGE ? { top: above, left } : corner;
}

type Spot = ReturnType<typeof place>;

/** The card's own box on screen, from where it was put. */
export function cardBox(
  spot: Spot,
  height: number,
  view = { width: window.innerWidth, height: window.innerHeight },
): Box {
  const width = Math.min(BUBBLE_WIDTH, view.width - EDGE * 2);
  return "top" in spot
    ? { top: spot.top, left: spot.left, width, height }
    : {
        top: view.height - spot.bottom - height,
        left: view.width - spot.right - width,
        width,
        height,
      };
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/**
 * The arrow's line, from the card's edge to just short of the control: a gentle curve with a
 * head. Null when the two are too close for an arrow to read (or the card sits on the control).
 */
export function arrowPath(from: Box, to: Box): { d: string; dx: number; dy: number } | null {
  const centre = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  const apart =
    from.left >= to.left + to.width ||
    to.left >= from.left + from.width ||
    from.top >= to.top + to.height ||
    to.top >= from.top + from.height;
  // To the nearest point of the control; into its middle when the card lies over part of it.
  const end = apart
    ? {
        x: clamp(centre.x, to.left, to.left + to.width),
        y: clamp(centre.y, to.top, to.top + to.height),
      }
    : { x: to.left + to.width / 2, y: to.top + to.height / 2 };
  const inset = apart ? 24 : 0;
  const start = {
    x: clamp(end.x, from.left + inset, from.left + from.width - inset),
    y: clamp(end.y, from.top, from.top + from.height),
  };
  const length = Math.hypot(end.x - start.x, end.y - start.y);
  if (length < 28) return null;
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  // Clear of the card's edge at one end and the ring at the other.
  const a = { x: start.x + ux * 6, y: start.y + uy * 6 };
  const b = { x: end.x - ux * 12, y: end.y - uy * 12 };
  const bend = Math.min(26, length * 0.18);
  const mid = { x: (a.x + b.x) / 2 - uy * bend, y: (a.y + b.y) / 2 + ux * bend };
  // The head follows the curve's last stretch.
  const hl = Math.hypot(b.x - mid.x, b.y - mid.y) || 1;
  const hx = (b.x - mid.x) / hl;
  const hy = (b.y - mid.y) / hl;
  const wing = (turn: number) => {
    const cos = Math.cos(turn);
    const sin = Math.sin(turn);
    return `${(b.x - (hx * cos - hy * sin) * 13).toFixed(1)} ${(b.y - (hx * sin + hy * cos) * 13).toFixed(1)}`;
  };
  const point = `${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  return {
    d: `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${mid.x.toFixed(1)} ${mid.y.toFixed(1)} ${point} M${wing(0.5)} L${point} L${wing(-0.5)}`,
    dx: ux,
    dy: uy,
  };
}

/** neb's arrow from the card to the control to press. */
function Arrow({ from, to }: { from: Box; to: Box }) {
  const arrow = arrowPath(from, to);
  if (!arrow) return null;
  return (
    <svg
      aria-hidden
      className="absolute inset-0 size-full overflow-visible"
      data-testid="tour-arrow"
    >
      <path
        d={arrow.d}
        className="tour-arrow"
        style={{ "--dx": `${arrow.dx * 7}px`, "--dy": `${arrow.dy * 7}px` } as React.CSSProperties}
        fill="none"
        stroke="var(--neb)"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
