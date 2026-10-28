"use client";

import type { MarkLevel } from "@mew/shared";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useMarkPrefs } from "../annotate/prefs";

/**
 * How much neb marks in this notebook (docs/NEB_APP_UI.md §4.3, decision U3): one pill with the
 * level (board 2) that opens Quiet / Hint / Coach, on the data's quiet / normal / coach. Off is
 * reached from the neb dot.
 */
const LEVELS: { level: MarkLevel; label: string; hint: string }[] = [
  { level: "quiet", label: "Quiet", hint: "Ticks only; neb counts the rest on its dot" },
  { level: "normal", label: "Hint", hint: "Ticks, circles and short notes in the margin" },
  { level: "coach", label: "Coach", hint: "Hint, plus neb may speak when you're stuck" },
];

export function LevelSwitch({ notebookId }: { notebookId: string | null }) {
  const level = useMarkPrefs((s) => s.levelFor(notebookId));
  const budgetSpent = useMarkPrefs((s) => Date.now() < s.quietUntil);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = LEVELS.find((l) => l.level === level);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative" data-testid="level-switch">
      <button
        type="button"
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`How much neb marks: ${current?.label ?? "Off"}`}
        title={
          budgetSpent ? "On Quiet for the rest of today: today's marking is used up" : current?.hint
        }
        disabled={!notebookId}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[0_1px_0_var(--line),inset_0_0_0_1px_var(--line)] hover:shadow-[inset_0_0_0_1px_var(--ink)]"
      >
        {current?.label ?? "Off"}
        <ChevronDown className="size-3.5 text-muted" aria-hidden />
      </button>
      {open && (
        <div
          role="radiogroup"
          aria-label="How much neb marks"
          className="absolute top-12 right-0 z-50 flex w-64 flex-col gap-0.5 rounded-[12px] bg-paper-hi p-1.5 shadow-sh-3"
        >
          {LEVELS.map((option) => (
            <button
              key={option.level}
              type="button"
              role="radio"
              aria-checked={level === option.level}
              onClick={() => {
                if (notebookId) useMarkPrefs.getState().setLevel(notebookId, option.level);
                setOpen(false);
              }}
              className="flex flex-col rounded-[8px] px-3 py-2 text-left hover:bg-ink/5 aria-checked:bg-ink/[0.06]"
            >
              <span className="text-sm font-semibold">{option.label}</span>
              <span className="text-xs text-muted">{option.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
