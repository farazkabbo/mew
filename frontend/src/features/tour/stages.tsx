"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/Button";
import { Keycap } from "@/components/ui/Keycap";
import { NebDot } from "@/components/ui/NebDot";

import { InkBox } from "../handwriting/InkBox";

/** A step's practice area. `onDone` is called once the student has done the thing. */
export type StageProps = { onDone(): void; desktop: boolean };

const card = "rounded-[14px] border border-line bg-paper-hi p-5 shadow-sh-1";
const said = "tour-in rounded-[12px] bg-neb-wash px-4 py-3 text-[15px] text-neb-ink";

function Said({ children }: { children: ReactNode }) {
  return (
    <p className={said} role="status">
      <span className="mr-2 font-semibold">neb:</span>
      {children}
    </p>
  );
}

// ─── 1. The desk ────────────────────────────────────────────────────────────────────────────────

const SPOTS = [
  {
    id: "notebooks",
    label: "Your notebooks",
    says: "One notebook per class. Open one to write, add a PDF, or see what you saved.",
  },
  {
    id: "review",
    label: "Review",
    says: "Everything due today: course topics to be quizzed on, and things you saved to check.",
  },
  {
    id: "you",
    label: "Your initial",
    says: "Settings, Teach neb, and How to use neb. This tour is there too, any time.",
  },
] as const;

export function DeskStage({ onDone }: StageProps) {
  const [seen, setSeen] = useState<readonly string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const tap = (id: string) => {
    setCurrent(id);
    const next = seen.includes(id) ? seen : [...seen, id];
    setSeen(next);
    if (next.length === SPOTS.length) onDone();
  };
  const spot = (id: string, className: string, children: ReactNode) => (
    <button
      type="button"
      onClick={() => tap(id)}
      aria-pressed={current === id}
      aria-label={SPOTS.find((s) => s.id === id)?.label}
      className={`${className} ${seen.includes(id) ? "" : "tour-pulse"} outline-offset-2 aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-neb`}
    >
      {children}
    </button>
  );
  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} bg-desk`} data-testid="tour-desk">
        <div className="flex items-center gap-3 border-b border-line pb-3">
          <span className="font-serif text-xl">Good evening.</span>
          <span className="flex-1" />
          <span className="rounded-full border border-line bg-paper px-3 py-1 text-xs text-muted">
            8 of 8 questions left
          </span>
          {spot("review", "rounded-full border border-ink px-3 py-1 text-sm font-medium", "Review")}
          {spot(
            "you",
            "grid size-9 place-items-center rounded-full bg-teal font-serif text-lg text-white",
            "F",
          )}
        </div>
        {spot(
          "notebooks",
          "mt-4 flex w-full gap-3 rounded-[10px] p-1 text-left",
          ["Physics", "Calculus", "Chemistry"].map((name, i) => (
            <span
              key={name}
              className="flex h-24 flex-1 flex-col justify-end rounded-[8px] p-3 text-sm font-semibold text-white"
              style={{ background: ["#5B4BC4", "#7DA4AF", "#C2453A"][i] }}
            >
              {name}
            </span>
          )),
        )}
      </div>
      <p className="text-sm text-muted" aria-live="polite">
        {seen.length} of {SPOTS.length} found
      </p>
      {current && <Said>{SPOTS.find((s) => s.id === current)?.says}</Said>}
    </div>
  );
}

// ─── 2. Writing, and live marks ─────────────────────────────────────────────────────────────────

const LEVELS = [
  { id: "quiet", name: "Quiet", note: "A “?” beside the line. Nothing more." },
  { id: "hint", name: "Hint", note: "Circles the slip: “look at this step again”." },
  { id: "coach", name: "Coach", note: "Circles it and nudges: “19 − 7 isn't 26. Try it again.”" },
] as const;

export function MarksStage({ onDone }: StageProps) {
  const [written, setWritten] = useState(false);
  const [marked, setMarked] = useState(false);
  const [level, setLevel] = useState<(typeof LEVELS)[number]["id"]>("hint");
  const [clearKey, setClearKey] = useState(0);
  useEffect(() => {
    if (!written) return;
    // neb marks a line once you pause, as it does on a real page.
    const timer = setTimeout(() => {
      setMarked(true);
      onDone();
    }, 1100);
    return () => clearTimeout(timer);
  }, [written, onDone]);
  const chosen = LEVELS.find((l) => l.id === level) ?? LEVELS[1];
  return (
    <div className="flex flex-col gap-4">
      <div className={card}>
        <p className="font-hand text-[26px] leading-none text-ink">3x + 7 = 19</p>
        <p className="mt-3 text-sm text-muted">
          Write the next line below, with a slip on purpose: <b className="text-ink">3x = 26</b>
        </p>
        <div className="relative mt-2 w-fit max-w-full">
          <InkBox
            label="Write the next line"
            width={420}
            height={96}
            clearKey={clearKey}
            onChange={(strokes) => setWritten(strokes.length > 0)}
          />
          {marked && (
            <svg
              key={level}
              viewBox="0 0 420 96"
              className="pointer-events-none absolute inset-0 size-full"
              aria-hidden
            >
              {level === "quiet" ? (
                <text x="392" y="60" fontSize="34" fill="var(--neb)" className="tour-in font-hand">
                  ?
                </text>
              ) : (
                <ellipse
                  cx="210"
                  cy="48"
                  rx="196"
                  ry="40"
                  fill="none"
                  stroke="var(--neb)"
                  strokeWidth="3"
                  className="tour-draw"
                  style={{ "--len": 800 } as React.CSSProperties}
                />
              )}
            </svg>
          )}
        </div>
        <div className="mt-2 flex items-center gap-3 text-sm">
          <button
            type="button"
            className="text-muted underline underline-offset-2 hover:text-ink"
            onClick={() => {
              setClearKey((k) => k + 1);
              setWritten(false);
              setMarked(false);
            }}
          >
            Clear and write again
          </button>
          {written && !marked && <span className="text-muted">neb is reading your line…</span>}
        </div>
      </div>
      {marked && (
        <>
          <Said>{chosen.note}</Said>
          <div role="radiogroup" aria-label="How much neb marks" className="flex flex-wrap gap-2">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                role="radio"
                aria-checked={level === l.id}
                onClick={() => setLevel(l.id)}
                className="rounded-full border border-line bg-paper px-4 py-1.5 text-sm font-medium aria-checked:border-ink aria-checked:bg-ink aria-checked:text-paper"
              >
                {l.name}
              </button>
            ))}
            <span className="self-center text-sm text-muted">Try each: the mark changes.</span>
          </div>
        </>
      )}
    </div>
  );
}

// ─── 3. Hold to talk ────────────────────────────────────────────────────────────────────────────

export function TalkStage({ onDone, desktop }: StageProps) {
  const [keys, setKeys] = useState({ ctrl: false, alt: false });
  const [pressed, setPressed] = useState(false);
  const [answered, setAnswered] = useState(false);
  const since = useRef(0);
  const holding = pressed || (keys.ctrl && keys.alt);

  // In the browser the real keys work here. In the Windows app they belong to Screen Coach
  // (holding them would really listen), so there the button below stands in for them.
  useEffect(() => {
    if (desktop) return;
    const set = (event: KeyboardEvent, down: boolean) => {
      if (event.key === "Control") setKeys((k) => ({ ...k, ctrl: down }));
      if (event.key === "Alt") {
        event.preventDefault(); // Alt alone would move focus to the browser's menu
        setKeys((k) => ({ ...k, alt: down }));
      }
    };
    const down = (event: KeyboardEvent) => set(event, true);
    const up = (event: KeyboardEvent) => set(event, false);
    const blur = () => setKeys({ ctrl: false, alt: false });
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [desktop]);

  useEffect(() => {
    if (holding) {
      since.current = Date.now();
      return;
    }
    if (since.current && Date.now() - since.current >= 500) {
      setAnswered(true);
      onDone();
    }
    since.current = 0;
  }, [holding, onDone]);

  return (
    <div className="flex flex-col gap-4">
      <div className={`${card} flex flex-col items-center gap-5 py-8`}>
        <div className="flex items-center gap-3" aria-hidden>
          <Keycap size="xl" pressed={holding || keys.ctrl}>
            Ctrl
          </Keycap>
          <span className="text-xl text-muted">+</span>
          <Keycap size="xl" pressed={holding || keys.alt}>
            Alt
          </Keycap>
        </div>
        <div className="flex h-10 items-center gap-3" aria-live="polite">
          <NebDot state={holding ? "listening" : "watching"} size={28} />
          {holding ? (
            <span className="flex items-end gap-1" aria-label="neb is listening">
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className="h-6 w-1.5 origin-bottom rounded-full bg-neb motion-safe:animate-[neb-bars_420ms_ease-in-out_infinite_alternate]"
                  style={{ animationDelay: `${i * 90}ms` }}
                />
              ))}
              <span className="ml-2 text-sm text-neb-ink">Listening. Let go to ask.</span>
            </span>
          ) : (
            <span className="text-sm text-muted">
              {answered ? "That's it. Hold, talk, let go." : "Waiting for you to hold."}
            </span>
          )}
        </div>
        <button
          type="button"
          data-testid="tour-hold"
          onPointerDown={() => setPressed(true)}
          onPointerUp={() => setPressed(false)}
          onPointerLeave={() => setPressed(false)}
          onKeyDown={(e) => (e.key === " " || e.key === "Enter") && setPressed(true)}
          onKeyUp={() => setPressed(false)}
          className={`${buttonClass(desktop ? "neb" : "ghost", { dense: true })} select-none touch-none`}
        >
          {desktop ? "Press and hold here to try it" : "Or press and hold here"}
        </button>
      </div>
      {answered && (
        <Said>
          “A derivative is the slope at one point.” That&apos;s how an answer sounds: out loud, and
          written beside your work.
        </Said>
      )}
      <p className="text-sm text-muted">
        {desktop
          ? "For real, hold the two keys on your keyboard, anywhere on your PC. Here the button stands in, so neb doesn't start listening during the tour."
          : "Hold both keys on your keyboard for about a second, then let go."}
      </p>
    </div>
  );
}

// ─── 4. Circle and ask ──────────────────────────────────────────────────────────────────────────

const QUESTIONS = [
  {
    ask: "Why is it steepest here?",
    steps: [
      "The arrow marks where the curve climbs fastest.",
      "Steeper line, faster change in velocity.",
      "So acceleration is greatest at that moment.",
    ],
  },
  {
    ask: "Explain this graph",
    steps: [
      "Velocity is on the side, time along the bottom.",
      "It rises quickly, then levels off.",
      "Levelling off means the speed stops changing.",
    ],
  },
  {
    ask: "Give me an example",
    steps: [
      "A car pulling away from a red light.",
      "It gains speed fast at first: the steep part.",
      "On the motorway it holds 100 km/h: the flat part.",
    ],
  },
] as const;

type Pt = readonly [number, number];
const toPath = (points: readonly Pt[]) =>
  points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

function Slide({ lasso, replay }: { lasso: string; replay?: number }) {
  return (
    <>
      <path d="M24 136 H300 M24 136 V16" stroke="var(--ink)" strokeWidth="2" fill="none" />
      <path
        d="M24 130 C90 126 130 52 200 40 S280 34 300 33"
        stroke="var(--ok-pen)"
        strokeWidth="3"
        fill="none"
      />
      <path
        d="M152 118 L134 74 M128 83 L134 70 L143 81"
        stroke="var(--red-pen)"
        strokeWidth="3"
        fill="none"
      />
      <text x="300" y="152" fontSize="11" textAnchor="end" fill="var(--muted)">
        time
      </text>
      <text x="30" y="20" fontSize="11" fill="var(--muted)">
        velocity
      </text>
      {lasso && (
        <path
          key={replay}
          d={lasso}
          fill="color-mix(in srgb, var(--neb) 10%, transparent)"
          stroke="var(--neb)"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          {...(replay !== undefined && {
            className: "tour-draw",
            style: { "--len": 900 } as React.CSSProperties,
          })}
        />
      )}
    </>
  );
}

function Steps({ steps, replay = 0 }: { steps: readonly string[]; replay?: number }) {
  return (
    <ol key={replay} className="flex flex-col gap-2">
      {steps.map((step, i) => (
        <li
          key={step}
          className="tour-in flex gap-2.5 text-[15px]"
          style={{ animationDelay: `${300 + i * 650}ms` }}
        >
          <span className="grid size-5 flex-none place-items-center rounded-full bg-neb text-[11px] font-semibold text-white">
            {i + 1}
          </span>
          {step}
        </li>
      ))}
    </ol>
  );
}

/** A lasso a tester (or a keyboard user) gets without drawing. */
const READY_LASSO: readonly Pt[] = Array.from({ length: 24 }, (_, i) => {
  const a = (i / 23) * Math.PI * 2;
  return [140 + Math.cos(a) * 34, 94 + Math.sin(a) * 38] as const;
});

export function CircleStage({ onDone }: StageProps) {
  const [points, setPoints] = useState<readonly Pt[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [asked, setAsked] = useState(false);
  const [question, setQuestion] = useState(0);
  const at = (event: React.PointerEvent<SVGSVGElement>): Pt => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      ((event.clientX - box.left) / box.width) * 320,
      ((event.clientY - box.top) / box.height) * 160,
    ];
  };
  const finish = (path: readonly Pt[]) => {
    setDrawing(false);
    if (path.length < 8) return setPoints([]);
    setPoints(path);
    setAsked(true);
    onDone();
  };
  const picked = QUESTIONS[question] ?? QUESTIONS[0];
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-[1.1fr_1fr]">
        <figure
          className={`${card} ${asked ? "outline outline-2 outline-neb" : ""}`}
          aria-label="A sample slide: velocity against time, with an arrow at the steepest part"
        >
          <figcaption className="font-serif text-lg">Lecture 4 · Acceleration</figcaption>
          <svg
            viewBox="0 0 320 160"
            data-testid="tour-slide"
            className="mt-1 w-full cursor-crosshair touch-none"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              setAsked(false);
              setDrawing(true);
              setPoints([at(e)]);
            }}
            onPointerMove={(e) => drawing && setPoints((p) => [...p, at(e)])}
            onPointerUp={() => drawing && finish(points)}
          >
            <Slide lasso={points.length > 1 ? toPath(points) + (asked ? " Z" : "") : ""} />
          </svg>
          {!asked && (
            <button
              type="button"
              onClick={() => finish(READY_LASSO)}
              className="mt-1 text-sm text-muted underline underline-offset-2 hover:text-ink"
            >
              Circle it for me
            </button>
          )}
        </figure>
        <div className={`${card} flex flex-col gap-3`} aria-live="polite">
          {asked ? (
            <>
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                Pick a question, or ask your own out loud
              </p>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Question">
                {QUESTIONS.map((q, i) => (
                  <button
                    key={q.ask}
                    type="button"
                    role="radio"
                    aria-checked={question === i}
                    onClick={() => setQuestion(i)}
                    className="rounded-full border border-line bg-paper px-3 py-1 text-sm aria-checked:border-neb aria-checked:bg-neb-wash aria-checked:text-neb-ink"
                  >
                    {q.ask}
                  </button>
                ))}
              </div>
              <Steps steps={picked.steps} replay={question} />
            </>
          ) : (
            <p className="text-muted">
              Drag a circle round the red arrow on the slide. neb looks only at what you circle.
            </p>
          )}
        </div>
      </div>
      {asked && (
        <p className="text-sm text-muted">
          The violet edge means neb is looking, only then. A follow-up on the same circle is free.
        </p>
      )}
    </div>
  );
}

// ─── 5. Save it, replay it ──────────────────────────────────────────────────────────────────────

export function SaveStage({ onDone }: StageProps) {
  const [saved, setSaved] = useState(false);
  const [replay, setReplay] = useState<number | undefined>(undefined);
  const lasso = `${toPath(READY_LASSO)} Z`;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className={`${card} flex flex-col gap-3`}>
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          neb&apos;s answer
        </p>
        <svg viewBox="0 0 320 160" className="w-full" aria-hidden>
          <Slide lasso={lasso} />
        </svg>
        <button
          type="button"
          disabled={saved}
          onClick={() => setSaved(true)}
          className={`${buttonClass("ink", { dense: true })} self-start ${saved ? "" : "tour-pulse"}`}
        >
          {saved ? "Saved to Physics" : "Save to notebook"}
        </button>
        <p className="text-sm text-muted">
          For real, every circled answer is saved for you. Say “save this to Physics” to choose
          where, or press Undo on the card.
        </p>
      </div>
      <div className={`${card} flex flex-col gap-3 bg-desk`} aria-live="polite">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">
          Physics · Moments
        </p>
        {saved ? (
          <div
            className="tour-drop rounded-[10px] bg-paper p-3 shadow-sh-2"
            data-testid="tour-moment"
          >
            <svg viewBox="0 0 320 160" className="w-full rounded-md bg-paper-hi" aria-hidden>
              <Slide lasso={lasso} {...(replay !== undefined && { replay })} />
            </svg>
            <p className="mt-2 text-sm font-medium">Why is it steepest here?</p>
            <p className="text-xs text-muted">Lecture 4 · Acceleration · saved just now</p>
            {replay !== undefined && (
              <div className="mt-3">
                <Steps steps={QUESTIONS[0].steps} replay={replay} />
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                setReplay((r) => (r ?? 0) + 1);
                onDone();
              }}
              className={`${buttonClass("neb", { dense: true })} mt-3 ${replay === undefined ? "tour-pulse" : ""}`}
            >
              {replay === undefined ? "▶ Replay" : "▶ Replay again"}
            </button>
          </div>
        ) : (
          <p className="text-muted">Nothing saved yet. Press Save to notebook.</p>
        )}
      </div>
    </div>
  );
}

// ─── 6. The tray icon and the tool bar (Windows app) ────────────────────────────────────────────

const TRAY_MENU = [
  "Open Neb",
  "Ask Neb  (hold Ctrl+Alt)",
  "Look at my screen",
  "Pause Screen Coach",
  "Pause for 1 hour",
  "Screen Coach settings…",
  "Quit",
] as const;

export function TrayStage({ onDone }: StageProps) {
  const [step, setStep] = useState<"bar" | "tray" | "menu" | "settings" | "on">("bar");
  const hint = {
    bar: "Click the ^ arrow, beside the clock.",
    tray: "There's neb. Right-click it (here, a click will do).",
    menu: "Choose Screen Coach settings…",
    settings: "Turn Screen Coach on.",
    on: "Screen Coach is on. Hold Ctrl + Alt anywhere to ask.",
  }[step];
  return (
    <div className="flex flex-col gap-4">
      <div className="relative overflow-hidden rounded-[14px] border border-line bg-[#1f2630] text-white shadow-sh-1">
        <div className="relative h-56">
          {step === "tray" && (
            <div className="tour-in absolute right-16 bottom-2 grid grid-cols-3 gap-2 rounded-lg bg-[#2b3440] p-3">
              <span className="size-7 rounded bg-white/15" />
              <span className="size-7 rounded bg-white/15" />
              <button
                type="button"
                aria-label="neb, in the hidden icons"
                onClick={() => setStep("menu")}
                className="tour-pulse grid size-7 place-items-center rounded bg-neb text-xs font-bold"
              >
                n
              </button>
            </div>
          )}
          {step === "menu" && (
            <ul
              role="menu"
              className="tour-in absolute right-10 bottom-2 w-60 rounded-lg bg-[#2b3440] p-1.5 text-sm"
            >
              {TRAY_MENU.map((item) => (
                <li key={item} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    disabled={item !== "Screen Coach settings…"}
                    onClick={() => setStep("settings")}
                    className="w-full rounded px-3 py-1.5 text-left enabled:bg-white/10 enabled:font-semibold disabled:opacity-60"
                  >
                    {item}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {(step === "settings" || step === "on") && (
            <div className="tour-in absolute inset-x-8 top-6 rounded-xl bg-paper p-5 text-ink">
              <p className="font-serif text-xl">Screen Coach</p>
              <label className="mt-3 flex items-center justify-between gap-4 text-sm">
                <span>
                  Let neb look at what I circle
                  <span className="block text-xs text-muted">
                    Only when you hold the keys. Never passwords or private windows.
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label="Turn on Screen Coach"
                  checked={step === "on"}
                  onChange={() => {
                    setStep("on");
                    onDone();
                  }}
                  className="size-5 accent-[var(--neb)]"
                />
              </label>
            </div>
          )}
        </div>
        <div className="flex h-11 items-center gap-3 bg-[#141a22] px-4 text-xs">
          <span className="size-5 rounded bg-white/20" />
          <span className="size-5 rounded bg-white/20" />
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Show hidden icons"
            onClick={() => step === "bar" && setStep("tray")}
            className={`grid size-7 place-items-center rounded text-base ${step === "bar" ? "tour-pulse bg-white/10" : ""}`}
          >
            ^
          </button>
          <span className="tabular-nums opacity-80">9:41 PM</span>
        </div>
      </div>
      <p className="text-[15px] font-medium" role="status">
        {hint}
      </p>
      {step === "on" && (
        <div className={`${card} tour-in flex flex-col gap-3`}>
          <p className="text-sm text-muted">
            Tap <Keycap size="sm">Ctrl</Keycap> + <Keycap size="sm">Alt</Keycap> twice and
            neb&apos;s tool bar appears at the top of your screen:
          </p>
          <div className="flex w-fit items-center gap-1.5 rounded-full bg-ink px-3 py-2 text-xs text-paper">
            <span className="mr-1 size-2.5 rounded-full bg-neb" />
            {["Select", "Pen", "Eraser", "Clear", "Mic"].map((tool) => (
              <span key={tool} className="rounded-full bg-white/10 px-2.5 py-1">
                {tool}
              </span>
            ))}
          </div>
          <p className="text-sm text-muted">
            <b className="text-ink">Select</b> is for circling with a pen or touch.{" "}
            <b className="text-ink">Tip:</b> drag neb&apos;s icon out of the ^ box onto the taskbar,
            so it&apos;s always in view.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── 7. A PDF becomes a quiz ────────────────────────────────────────────────────────────────────

const PATH = [
  { button: "Add course material", after: "Choose your slides or a textbook chapter (a PDF)." },
  {
    button: "Use as course material",
    after: "neb reads it and finds the topics. A minute or two.",
  },
  { button: "Start studying", after: "On the Study tab, after you've checked the topics." },
  { button: "Quiz me", after: "" },
] as const;

export function QuizStage({ onDone }: StageProps) {
  const [at, setAt] = useState(0);
  return (
    <div className="flex flex-col gap-4">
      <ol className={`${card} flex flex-col gap-3`}>
        {PATH.map((step, i) => (
          <li key={step.button} className="flex flex-wrap items-center gap-3">
            <span
              className={`grid size-6 flex-none place-items-center rounded-full text-xs font-semibold ${i < at ? "bg-neb text-white" : "bg-line text-muted"}`}
            >
              {i < at ? "✓" : i + 1}
            </span>
            <button
              type="button"
              disabled={i !== at}
              onClick={() => {
                setAt(i + 1);
                if (i + 1 === PATH.length) onDone();
              }}
              className={`${buttonClass(i === at ? "ink" : "ghost", { dense: true })} ${i === at ? "tour-pulse" : ""} disabled:opacity-50`}
            >
              {step.button}
            </button>
            {i < at && step.after && (
              <span className="tour-in text-sm text-muted">{step.after}</span>
            )}
          </li>
        ))}
      </ol>
      {at === PATH.length && (
        <div className={`${card} tour-in`} data-testid="tour-quiz">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">
            Question 1 · Measures of centre
          </p>
          <p className="mt-2 font-serif text-xl">
            Five test scores are 4, 8, 9, 9 and 30. Why is the median a better summary than the mean
            here?
          </p>
          <p className="mt-3 text-sm text-muted">
            Write your answer on the page or say it. neb marks it, and Hint helps without giving it
            away.
          </p>
        </div>
      )}
      <p className="text-sm text-muted">
        These four buttons are in a notebook: open one from your desk. Coach mode is different: it
        walks you through a task in another app, and doesn&apos;t quiz you on a PDF.
      </p>
    </div>
  );
}
