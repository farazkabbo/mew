"use client";

import type { MarkLevel } from "@mew/shared";
import { useEffect, useRef, useState } from "react";

import { buttonClass } from "@/components/ui/Button";
import { NebDot } from "@/components/ui/NebDot";

import { useMarkPrefs } from "../annotate/prefs";
import { Calibration } from "../handwriting/Calibration";
import { saveWritingHand, type WritingHand } from "../page/PencilCase";

type Step = "hand" | "handwriting" | "level" | "listen";
const STEPS: readonly Step[] = ["hand", "handwriting", "level", "listen"];

const TITLES: Record<Step, string> = {
  hand: "Which hand do you write with?",
  handwriting: "Teach neb your handwriting",
  level: "How much should neb mark?",
  listen: "Talk while you study",
};

const LEVELS: { level: MarkLevel; name: string; what: string; marks: string }[] = [
  { level: "quiet", name: "Quiet", what: "Only ticks and a “?” when unsure.", marks: "✓  ?" },
  { level: "normal", name: "Hint", what: "Circles a slip and says where to look.", marks: "✓  ◯" },
  { level: "coach", name: "Coach", what: "Hints, and a nudge if you're stuck.", marks: "✓  ◯  →" },
];

/**
 * First run (NEB_APP_UI §5.10, about 90 s, skippable at every step): the writing hand (where the
 * pencil case sits), K10's 60-second handwriting calibration, how much neb marks (this device's
 * level for notebooks), then starting to listen (a real click, so the browser allows audio and
 * the microphone prompt). The first notebook is named on the desk's first-run cover.
 */
export function Onboarding({
  onDone,
  onStartListening,
  onHand,
}: {
  onDone(): void;
  onStartListening(): void;
  /** The hand chosen: the pencil case moves to the other side at once. */
  onHand?(hand: WritingHand): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const step = STEPS[index] ?? "listen";
  const level = useMarkPrefs((s) => s.defaultLevel);
  const setLevel = useMarkPrefs((s) => s.setDefaultLevel);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => element?.close();
  }, []);

  const next = () => setIndex((i) => Math.min(i + 1, STEPS.length - 1));
  const finish = (listen: boolean) => {
    dialog.current?.close();
    if (listen) onStartListening();
    onDone();
  };
  const chooseHand = (hand: WritingHand) => {
    saveWritingHand(hand);
    onHand?.(hand);
    next();
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      onCancel={(e) => {
        e.preventDefault(); // Escape: same as "Skip"
        finish(false);
      }}
      className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-[14px] border-0 bg-desk p-0 text-ink shadow-sh-3 backdrop:bg-ink/30"
    >
      <div className="flex flex-col gap-6 p-8">
        <header className="flex items-center gap-3">
          <NebDot state="watching" size={26} />
          <span className="flex flex-1 gap-1" aria-hidden>
            {STEPS.map((s, i) => (
              <span
                key={s}
                className={`h-1 w-8 rounded-full ${i <= index ? "bg-neb" : "bg-line"}`}
              />
            ))}
          </span>
          <span className="text-xs text-muted" aria-live="polite">
            {index + 1} of {STEPS.length}
          </span>
        </header>
        <h2 id="onboarding-title" className="font-serif text-[40px] leading-tight">
          {TITLES[step]}
        </h2>

        {step === "hand" && (
          <div className="grid grid-cols-2 gap-4">
            {(["left", "right"] as const).map((hand) => (
              <button
                key={hand}
                type="button"
                autoFocus={hand === "right"}
                onClick={() => chooseHand(hand)}
                className="flex h-36 flex-col items-center justify-center gap-2 rounded-[12px] bg-paper text-lg font-medium shadow-sh-1 hover:shadow-sh-2"
              >
                <span
                  aria-hidden
                  className={`font-hand text-[44px] ${hand === "left" ? "-scale-x-100" : ""}`}
                >
                  ✍
                </span>
                {hand === "left" ? "Left hand" : "Right hand"}
              </button>
            ))}
          </div>
        )}

        {step === "handwriting" && (
          <div>
            <p className="mb-4 text-muted">60 seconds, so neb reads your 7s and your xs right.</p>
            <Calibration skipLabel="Skip, neb will learn as you go" onDone={next} />
          </div>
        )}

        {step === "level" && (
          <div role="radiogroup" aria-label="How much neb marks" className="grid grid-cols-3 gap-3">
            {LEVELS.map((option) => (
              <button
                key={option.level}
                type="button"
                role="radio"
                aria-checked={level === option.level}
                onClick={() => setLevel(option.level)}
                className="flex flex-col gap-2 rounded-[12px] border-2 border-transparent bg-paper p-4 text-left shadow-sh-1 aria-checked:border-ink"
              >
                <span
                  aria-hidden
                  className="flex h-16 items-center justify-center rounded-[6px] bg-paper-hi font-hand text-[26px] text-neb"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(transparent 0 15px, var(--rule) 15px 16px)",
                  }}
                >
                  {option.marks}
                </span>
                <span className="text-[15px] font-semibold">{option.name}</span>
                <span className="text-[13px] text-muted">{option.what}</span>
              </button>
            ))}
          </div>
        )}

        {step === "listen" && (
          <p className="leading-relaxed text-muted">
            neb listens and stays quiet until you need it. Ask a question, say “is this right?”, or
            tap the dot. It answers out loud and writes on your page.
          </p>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => finish(false)}
            className="text-sm text-muted hover:text-ink"
          >
            {step === "listen" ? "Not now" : "Skip"}
          </button>
          <div className="flex gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={() => setIndex(index - 1)}
                className={buttonClass("quiet", { dense: true })}
              >
                Back
              </button>
            )}
            {step === "level" && (
              <button
                type="button"
                autoFocus
                onClick={next}
                className={buttonClass("ink", { dense: true })}
              >
                Next
              </button>
            )}
            {step === "listen" && (
              <button
                type="button"
                autoFocus
                onClick={() => finish(true)}
                className={buttonClass("neb", { dense: true })}
              >
                Start listening
              </button>
            )}
          </div>
        </footer>
      </div>
    </dialog>
  );
}
