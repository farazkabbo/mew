"use client";

import type { MarkLevel } from "@mew/shared";

import { useMarkPrefs } from "../annotate/prefs";

/**
 * How much neb marks in this notebook (docs/NEB_APP_UI.md §4.3, decision U3): Quiet / Hint /
 * Coach on the data's quiet / normal / coach. Off is reached from the neb dot.
 */
const LEVELS: { level: MarkLevel; label: string; hint: string }[] = [
  { level: "quiet", label: "Quiet", hint: "Ticks only; neb counts the rest on its dot" },
  { level: "normal", label: "Hint", hint: "Ticks, circles and short notes in the margin" },
  { level: "coach", label: "Coach", hint: "Hint, plus neb may speak when you're stuck" },
];

export function LevelSwitch({ notebookId }: { notebookId: string | null }) {
  const level = useMarkPrefs((s) => s.levelFor(notebookId));
  const chosen = useMarkPrefs((s) => s.prefsFor(notebookId).level);
  const budgetSpent = useMarkPrefs((s) => Date.now() < s.quietUntil);
  return (
    <div
      role="radiogroup"
      aria-label="How much neb marks"
      data-testid="level-switch"
      className="flex h-9 items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--desk)_80%,var(--ink))] p-[3px]"
      title={budgetSpent ? "On Quiet for the rest of today: today's marking is used up" : undefined}
    >
      {LEVELS.map((option) => {
        const on = level === option.level;
        return (
          <button
            key={option.level}
            type="button"
            role="radio"
            aria-checked={on}
            title={option.hint}
            disabled={!notebookId}
            onClick={() => notebookId && useMarkPrefs.getState().setLevel(notebookId, option.level)}
            className={`h-[30px] rounded-full px-3.5 text-[13px] font-medium transition-colors duration-[120ms] ${
              on ? "bg-paper text-ink shadow-[0_1px_0_var(--line)]" : "text-muted hover:text-ink"
            } ${chosen === "off" ? "opacity-60" : ""}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
