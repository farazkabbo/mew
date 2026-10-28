"use client";

import { GraduationCap, Mic, PenLine } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { Calibration } from "../handwriting/Calibration";

const STEPS: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <PenLine className="size-6 text-accent" aria-hidden />,
    title: "Write here",
    body: "This is your notebook. Write with a pen, a mouse or a trackpad, just as on paper. When you pause, Neb reads your handwriting.",
  },
  {
    icon: <Mic className="size-6 text-tutor" aria-hidden />,
    title: "Talk while you study",
    body: "Neb listens and stays quiet until you need it. Ask a question, say “is this right?”, or tap Neb in the corner. It answers out loud and writes on your page.",
  },
  {
    icon: <GraduationCap className="size-6 text-check" aria-hidden />,
    title: "Learn from your own material",
    body: "Upload a chapter in Courses: you get lessons, quizzes in the notebook, and reviews spaced so things stick.",
  },
];

/**
 * First-run introduction (M9): three short cards, the optional 60-second handwriting calibration
 * (K10 §8.3), then the choice to start listening (a real click, so the browser allows audio and
 * the microphone prompt). A native modal dialog, so focus stays inside and Escape closes it.
 */
export function Onboarding({
  onDone,
  onStartListening,
}: {
  onDone(): void;
  onStartListening(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const last = step === STEPS.length - 1;
  const current = STEPS[step] ?? STEPS[0];

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  const finish = (listen: boolean) => {
    dialog.current?.close();
    if (listen) onStartListening();
    onDone();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="onboarding-title"
      onCancel={(e) => {
        e.preventDefault(); // Escape: same as "Skip"
        finish(false);
      }}
      className={`m-auto ${calibrating ? "w-[min(34rem,calc(100vw-2rem))]" : "w-[min(28rem,calc(100vw-2rem))]"} rounded-3xl border border-rule bg-paper-raised p-0 text-ink shadow-2xl backdrop:bg-ink/30`}
    >
      {calibrating ? (
        <div className="p-7">
          <h2 id="onboarding-title" className="font-serif text-3xl">
            Teach neb your handwriting
          </h2>
          <div className="mt-4">
            <Calibration
              skipLabel="Skip, neb will learn as you go"
              onDone={() => {
                setCalibrating(false);
                setStep(STEPS.length - 1);
              }}
            />
          </div>
        </div>
      ) : (
        <div className="p-7">
          <div className="flex items-center justify-between">
            {current?.icon}
            <span className="text-xs text-ink-muted" aria-live="polite">
              {step + 1} of {STEPS.length}
            </span>
          </div>
          <h2 id="onboarding-title" className="mt-4 font-serif text-3xl">
            {current?.title}
          </h2>
          <p className="mt-3 leading-relaxed text-ink-muted">{current?.body}</p>
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => finish(false)}
              className="text-sm text-ink-muted hover:text-ink"
            >
              {last ? "Not now" : "Skip"}
            </button>
            <div className="flex gap-2">
              {step > 0 && (
                <button
                  type="button"
                  onClick={() => setStep(step - 1)}
                  className="rounded-full border border-rule px-4 py-1.5 text-sm hover:border-accent"
                >
                  Back
                </button>
              )}
              {last && (
                <button
                  type="button"
                  onClick={() => setCalibrating(true)}
                  className="rounded-full border border-rule px-4 py-1.5 text-sm hover:border-accent"
                >
                  Teach neb my handwriting (60 s)
                </button>
              )}
              {last ? (
                <button
                  type="button"
                  autoFocus
                  onClick={() => finish(true)}
                  className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper"
                >
                  Start listening
                </button>
              ) : (
                <button
                  type="button"
                  autoFocus
                  onClick={() => setStep(step + 1)}
                  className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper"
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </dialog>
  );
}
