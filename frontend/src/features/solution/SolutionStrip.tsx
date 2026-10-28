"use client";

import type { LocalSolution } from "./record";

/**
 * The solution strip (docs/NEB_APP_UI.md §5.3, board 3): neb's worked steps, docked by the
 * margin over the page while the solution is open. Each step: its number, the step in neb's
 * violet handwriting, and why, in its pixel voice. The last line says how it was checked. It
 * folds away when the student starts their turn.
 */
export function SolutionStrip({
  solution,
  onFold,
}: {
  solution: Pick<LocalSolution, "steps" | "verifiedBy" | "finalAnswer">;
  onFold?(): void;
}) {
  const steps = solution.steps ?? [];
  if (steps.length === 0) return null;
  return (
    <section
      aria-label="neb's worked steps"
      data-testid="solution-strip"
      className="pointer-events-auto relative flex max-h-full w-[min(520px,100%)] flex-col overflow-y-auto rounded-r-[10px] border-l-[6px] border-neb bg-neb-wash py-4 pr-5 pl-5 shadow-sh-2"
      style={{
        // Faint creases every quarter, like a strip folded in four (§5.3).
        backgroundImage:
          "linear-gradient(transparent calc(25% - 1px), color-mix(in srgb, var(--neb) 12%, transparent) 25%, transparent calc(25% + 1px), transparent calc(50% - 1px), color-mix(in srgb, var(--neb) 12%, transparent) 50%, transparent calc(50% + 1px), transparent calc(75% - 1px), color-mix(in srgb, var(--neb) 12%, transparent) 75%, transparent calc(75% + 1px))",
      }}
    >
      <header className="mb-3 flex items-center justify-between gap-3">
        <span className="neb-voice text-[13px]">neb · every step, drawn first</span>
        {onFold && (
          <button
            type="button"
            onClick={onFold}
            className="neb-voice rounded-full border border-neb px-2.5 py-0.5 text-xs normal-case hover:bg-paper"
          >
            fold it away
          </button>
        )}
      </header>
      <ol className="flex flex-col gap-3.5">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-3">
            <span
              aria-hidden
              className="neb-voice mt-1 grid size-6 shrink-0 place-items-center rounded-full bg-neb text-xs text-white"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="font-hand text-[26px] leading-tight text-neb-ink">
                <span className="sr-only">Step {i + 1}: </span>
                {step.latex ? plainMaths(step.latex) : step.work}
              </p>
              <p className="neb-voice text-[13px]">{step.why}</p>
            </div>
          </li>
        ))}
        {solution.finalAnswer && (
          <li className="flex gap-3">
            <span aria-hidden className="mt-1 grid size-6 shrink-0 place-items-center text-neb-ink">
              ✓
            </span>
            <div className="min-w-0">
              <p className="font-hand text-[26px] leading-tight text-neb-ink">
                {solution.finalAnswer}
              </p>
              {solution.verifiedBy && (
                <p className="neb-voice text-[13px]">{CHECKED_BY[solution.verifiedBy]}</p>
              )}
            </div>
          </li>
        )}
      </ol>
    </section>
  );
}

const CHECKED_BY: Record<NonNullable<LocalSolution["verifiedBy"]>, string> = {
  sympy: "checked a second way: the maths agrees.",
  chem_balance: "checked: every atom balances.",
  code: "checked by running it.",
  rubric: "checked against the marking points.",
};

/** LaTeX as it reads on paper (the strip's handwriting font has no maths typesetting). */
export function plainMaths(latex: string): string {
  return latex
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2")
    .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
    .replace(/\\(cdot|times)/g, "×")
    .replace(/\\div/g, "÷")
    .replace(/\\(left|right|,|;|!|quad)/g, "")
    .replace(/\\(alpha|beta|theta|pi|Delta|rho|omega|mu|lambda)/g, (_, g: string) => GREEK[g] ?? g)
    .replace(/\^\{([^{}]*)\}/g, "^$1")
    .replace(/_\{([^{}]*)\}/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/\\([a-z]+)/gi, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const GREEK: Record<string, string> = {
  alpha: "α",
  beta: "β",
  theta: "θ",
  pi: "π",
  Delta: "Δ",
  rho: "ρ",
  omega: "ω",
  mu: "μ",
  lambda: "λ",
};
