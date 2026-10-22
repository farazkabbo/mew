"use client";

import type { ConceptProgress, PracticeQuestion } from "@mew/shared";
import { Check, Lightbulb, X } from "lucide-react";
import { useState } from "react";

import { coursesApi } from "./api";

type Result = { correct: boolean; withHint: boolean };

/**
 * One practice question. The student answers (on paper, or in the box), may take the hint, then
 * reveals the model answer and says honestly whether they had it. Taking the hint first records
 * the answer as "with hint" rather than independent.
 */
export function PracticeCard({
  courseId,
  conceptId,
  index,
  question,
  onRecorded,
}: {
  courseId: string;
  conceptId: string;
  index: number;
  question: PracticeQuestion;
  onRecorded(progress: ConceptProgress): void;
}) {
  const [hint, setHint] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const record = (correct: boolean) => {
    setError(null);
    coursesApi
      .attempt(courseId, {
        conceptId,
        correct,
        evidence: hint ? "with_hint" : "independent",
        source: "practice",
      })
      .then(
        (progress) => {
          setResult({ correct, withHint: hint });
          onRecorded(progress);
        },
        () => setError("Couldn't save that. Try again in a moment."),
      );
  };

  return (
    <li
      data-testid="practice-question"
      className="rounded-xl border border-rule bg-paper-raised p-5"
    >
      <p className="font-medium">
        {index + 1}. {question.question}
      </p>
      <textarea
        aria-label={`Your answer to question ${index + 1}`}
        rows={2}
        disabled={revealed}
        placeholder="Your answer (or work it out in the notebook)"
        className="mt-3 w-full resize-y rounded-lg border border-rule bg-paper px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-70"
      />
      {hint && question.hint && (
        <p className="mt-2 flex gap-2 text-sm">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-tutor" aria-hidden />
          {question.hint}
        </p>
      )}
      {revealed && (
        <div className="mt-3 rounded-lg border border-rule bg-paper p-3 text-sm">
          <p className="text-xs tracking-wide text-ink-muted uppercase">Model answer</p>
          <p className="mt-1 whitespace-pre-wrap">{question.answer}</p>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {!revealed && (
          <>
            {question.hint && !hint && (
              <button onClick={() => setHint(true)} className={SECONDARY}>
                Show hint
              </button>
            )}
            <button onClick={() => setRevealed(true)} className={PRIMARY}>
              Check my answer
            </button>
          </>
        )}
        {revealed && !result && (
          <>
            <span className="text-ink-muted">Did you have it?</span>
            <button onClick={() => record(true)} className={SECONDARY}>
              <Check className="size-4 text-check" aria-hidden />I had it
            </button>
            <button onClick={() => record(false)} className={SECONDARY}>
              <X className="size-4 text-error" aria-hidden />
              Not quite
            </button>
          </>
        )}
        {result && (
          <span role="status" className={result.correct ? "text-check" : "text-ink-muted"}>
            {result.correct
              ? result.withHint
                ? "Recorded: correct with a hint."
                : "Recorded: correct on your own."
              : "Recorded. It'll come back for another go soon."}
          </span>
        )}
        {error && (
          <span role="alert" className="text-error">
            {error}
          </span>
        )}
      </div>
    </li>
  );
}

const SECONDARY =
  "inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1 hover:border-accent";
const PRIMARY = "rounded-full bg-ink px-3 py-1 font-medium text-paper";
