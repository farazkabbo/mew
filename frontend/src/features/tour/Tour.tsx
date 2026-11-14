"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ComponentType, useEffect, useState, useSyncExternalStore } from "react";

import { buttonClass } from "@/components/ui/Button";
import { NebDot } from "@/components/ui/NebDot";

import { isDesktop } from "../desktop/bridge";
import { markTourSeen } from "./seen";
import {
  CircleStage,
  DeskStage,
  MarksStage,
  QuizStage,
  SaveStage,
  type StageProps,
  TalkStage,
  TrayStage,
} from "./stages";

export type TourStep = {
  id: string;
  title: string;
  /** One or two sentences: what this is, and what to do now. */
  lead: string;
  /** What the student does to finish the step (absent: nothing to do, just read). */
  task?: string;
  Stage?: ComponentType<StageProps>;
  /** Only in the Windows app (the browser has no Screen Coach). */
  desktopOnly?: boolean;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to neb",
    lead: "neb is a tutor that sits beside your work. It stays quiet until you ask or get stuck, then answers out loud and writes on your page. This tour takes about three minutes, and you try each thing yourself.",
  },
  {
    id: "desk",
    title: "Your desk",
    lead: "This is home: your notebooks, what's due, and how many questions you have left.",
    task: "Click the three glowing parts to see what each is for.",
    Stage: DeskStage,
  },
  {
    id: "marks",
    title: "Write, and neb marks as you go",
    lead: "In a notebook you write by hand. When you finish a line and pause, neb reads it: a tick if it's right, a circle where something slipped.",
    task: "Write the line with the mouse, a pen or your finger, then wait a second.",
    Stage: MarksStage,
  },
  {
    id: "talk",
    title: "Hold two keys to ask",
    lead: "Ctrl + Alt is the one gesture to remember. Hold them, ask your question out loud, and let go.",
    task: "Hold for a second, then let go.",
    Stage: TalkStage,
  },
  {
    id: "circle",
    title: "Circle anything and ask about it",
    lead: "On a video, a slide or a website: hold Ctrl + Alt and circle what you mean. neb explains it step by step, right beside it.",
    task: "Drag a circle round the red arrow.",
    Stage: CircleStage,
  },
  {
    id: "save",
    title: "It's saved, and you can replay it",
    lead: "What neb explained goes into your notebook's Moments, with the picture. Replay draws the explanation again, as it happened.",
    task: "Save the answer, then press Replay.",
    Stage: SaveStage,
  },
  {
    id: "tray",
    title: "Find neb in the taskbar, and turn on Screen Coach",
    lead: "In the Windows app, neb lives beside the clock, in the taskbar's hidden icons. Its menu is where you turn Screen Coach on, pause it, or stop a walkthrough.",
    task: "Follow the glowing buttons on this practice taskbar.",
    Stage: TrayStage,
    desktopOnly: true,
  },
  {
    id: "quiz",
    title: "Turn a PDF into a quiz",
    lead: "Add your slides or a chapter to a notebook, and neb builds lessons and quizzes from the subject.",
    task: "Press the four buttons in order.",
    Stage: QuizStage,
  },
  {
    id: "done",
    title: "You're ready",
    lead: "You have 8 free questions. A follow-up on the same thing doesn't use one, and your notebooks keep working at zero.",
  },
];

/** The steps for this app: the taskbar step is the Windows app's only. */
export function stepsFor(desktop: boolean): readonly TourStep[] {
  return TOUR_STEPS.filter((step) => desktop || !step.desktopOnly);
}

const noChange = () => () => undefined;

/**
 * The interactive tour (docs/NEB_APP_UI.md decision U31): each thing neb does, tried once on a
 * practice version of the real screen. Nothing here calls the model or uses a question. Every
 * step can be skipped, and the whole tour too.
 */
export function Tour({ userId }: { userId: string }) {
  const router = useRouter();
  const desktop = useSyncExternalStore(noChange, isDesktop, () => false);
  const steps = stepsFor(desktop);
  const [index, setIndex] = useState(0);
  const [done, setDone] = useState<readonly string[]>([]);
  const step = steps[Math.min(index, steps.length - 1)] ?? TOUR_STEPS[0]!;
  const last = index >= steps.length - 1;
  const finished = !step.Stage || done.includes(step.id);

  const stepId = step.id;
  const markDone = () => setDone((ids) => (ids.includes(stepId) ? ids : [...ids, stepId]));
  const leave = (to: string) => {
    markTourSeen(userId);
    router.push(to);
  };
  // Opening the tour counts as having been shown it: it never opens by itself twice.
  useEffect(() => markTourSeen(userId), [userId]);

  const Stage = step.Stage;
  return (
    <div className="min-h-dvh bg-desk text-ink" data-testid="tour">
      <header className="mx-auto flex max-w-4xl items-center gap-4 px-6 pt-6">
        <NebDot state="watching" size={26} />
        <ol className="flex flex-1 gap-1.5" aria-label="Progress">
          {steps.map((s, i) => (
            <li
              key={s.id}
              aria-current={i === index ? "step" : undefined}
              className={`h-1.5 flex-1 rounded-full transition-colors duration-300 ${i <= index ? "bg-neb" : "bg-line"}`}
            >
              <span className="sr-only">{s.title}</span>
            </li>
          ))}
        </ol>
        <span className="text-xs text-muted tabular-nums">
          {index + 1} of {steps.length}
        </span>
        <button
          type="button"
          onClick={() => leave("/desk")}
          className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Skip the tour
        </button>
      </header>

      <main key={step.id} className="tour-in mx-auto max-w-4xl px-6 pt-8 pb-28">
        <h1 className="font-serif text-[40px] leading-tight sm:text-[46px]">{step.title}</h1>
        <p className="mt-3 max-w-2xl text-[17px] leading-relaxed text-muted">{step.lead}</p>
        {step.task && (
          <p
            className={`mt-4 inline-flex items-center gap-2 rounded-full px-4 py-1.5 text-sm font-medium ${finished ? "bg-neb-wash text-neb-ink" : "bg-ink text-paper"}`}
            aria-live="polite"
          >
            <span aria-hidden>{finished ? "✓" : "→"}</span>
            {finished ? "Done. Carry on when you're ready." : step.task}
          </p>
        )}
        <div className="mt-6">
          {Stage && <Stage onDone={markDone} desktop={desktop} />}
          {step.id === "welcome" && <Welcome />}
          {step.id === "done" && <Ready />}
        </div>
      </main>

      <footer className="fixed inset-x-0 bottom-0 border-t border-line bg-desk/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-6 py-3.5">
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex(index - 1)}
              className={buttonClass("quiet", { dense: true })}
            >
              Back
            </button>
          )}
          <span className="flex-1" />
          {!finished && (
            <button
              type="button"
              onClick={() => setIndex(index + 1)}
              className="text-sm text-muted underline-offset-2 hover:text-ink hover:underline"
            >
              Skip this step
            </button>
          )}
          {last ? (
            <button
              type="button"
              onClick={() => leave("/desk")}
              className={buttonClass("neb", { dense: true })}
            >
              Open my desk
            </button>
          ) : (
            <button
              type="button"
              disabled={!finished}
              onClick={() => setIndex(index + 1)}
              className={`${buttonClass("ink", { dense: true })} disabled:opacity-40`}
            >
              {index === 0 ? "Start" : "Next"}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function Welcome() {
  const beats = [
    ["✍", "You write and talk", "By hand, in a notebook, or over any app on your screen."],
    [
      "◯",
      "neb marks and explains",
      "A circle where something slipped. Steps beside what you ask about.",
    ],
    [
      "↻",
      "It comes back when it matters",
      "Saved moments and quizzes return just before you'd forget.",
    ],
  ] as const;
  return (
    <ul className="grid gap-4 sm:grid-cols-3">
      {beats.map(([mark, title, text], i) => (
        <li
          key={title}
          className="tour-in rounded-[14px] border border-line bg-paper-hi p-5 shadow-sh-1"
          style={{ animationDelay: `${200 + i * 260}ms` }}
        >
          <span aria-hidden className="font-hand text-[40px] leading-none text-neb">
            {mark}
          </span>
          <p className="mt-2 font-semibold">{title}</p>
          <p className="mt-1 text-sm text-muted">{text}</p>
        </li>
      ))}
    </ul>
  );
}

function Ready() {
  return (
    <div className="flex flex-col gap-4">
      <ul className="grid gap-3 sm:grid-cols-2">
        {[
          ["Hold Ctrl + Alt", "to ask, anywhere"],
          ["Hold and circle", "to ask about one thing"],
          ["Tap Ctrl + Alt twice", "for the tool bar (pen and touch)"],
          ["Add course material", "in a notebook, for lessons and quizzes"],
        ].map(([what, why], i) => (
          <li
            key={what}
            className="tour-in rounded-[12px] border border-line bg-paper-hi px-4 py-3"
            style={{ animationDelay: `${i * 140}ms` }}
          >
            <span className="font-semibold">{what}</span> <span className="text-muted">{why}</span>
          </li>
        ))}
      </ul>
      <p className="text-sm text-muted">
        Everything here is written down in{" "}
        <Link href="/guide" className="font-medium text-ink underline underline-offset-2">
          How to use neb
        </Link>
        , and you can take this tour again from the same menu: your initial, at the top right of
        your desk.
      </p>
    </div>
  );
}
