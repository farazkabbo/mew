"use client";

import { Check, Loader2, Sparkles, X } from "lucide-react";

import { StatusChip } from "../courses/StatusChip";
import type { QuizSession } from "./session";
import { useQuiz } from "./store";

const VERDICT_TONE = {
  correct: "text-check",
  partly: "text-tutor",
  incorrect: "text-error",
  unreadable: "text-ink-muted",
} as const;

/** The running quiz: the question, its controls, and how the answer went. */
export function QuizCard({ session }: { session: QuizSession }) {
  const quiz = useQuiz();
  if (!quiz.active) return null;
  const { question, phase } = quiz;
  const showAnswer = Boolean(question) && (quiz.revealed || phase === "self");

  return (
    <section
      aria-label="Quiz"
      data-testid="quiz-card"
      className="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] rounded-2xl border border-rule bg-paper-raised p-4 shadow-lg"
    >
      <header className="flex items-center gap-2 text-xs text-ink-muted">
        <Sparkles className="size-3.5 text-tutor" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Quiz · {quiz.courseTitle || "Course"}</span>
        {quiz.asked > 0 && (
          <span data-testid="quiz-score">
            {quiz.correct} of {quiz.asked} right
          </span>
        )}
        <button
          onClick={() => void session.stop()}
          aria-label="End quiz"
          title="End quiz"
          className="grid size-6 place-items-center rounded-md hover:bg-ink/5 hover:text-ink"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </header>

      {phase === "loading" && (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Choosing a question…
        </p>
      )}

      {question && phase !== "loading" && (
        <div className="mt-3">
          <p className="text-xs font-medium text-accent">{question.conceptTitle}</p>
          <p data-testid="quiz-question" className="mt-1 font-serif text-lg leading-snug">
            {question.question}
          </p>
          {phase === "asking" && !quiz.feedback && (
            <p className="mt-2 text-xs text-ink-muted">
              Write your answer on the page (or say it), then check it.
            </p>
          )}
          {quiz.hintShown && question.hint && (
            <p className="mt-2 text-sm">
              <span className="text-ink-muted">Hint: </span>
              {question.hint}
            </p>
          )}
          {quiz.feedback && (
            <p
              role="status"
              data-testid="quiz-feedback"
              className={`mt-2 text-sm ${VERDICT_TONE[quiz.feedback.verdict]}`}
            >
              {quiz.feedback.text}
            </p>
          )}
          {showAnswer && (
            <div className="mt-2 rounded-lg border border-rule bg-paper p-2.5 text-sm">
              <p className="text-xs tracking-wide text-ink-muted uppercase">Model answer</p>
              <p className="mt-0.5 whitespace-pre-wrap">{question.answer}</p>
            </div>
          )}
        </div>
      )}

      {quiz.message && (
        <p role="alert" className="mt-2 text-sm text-ink-muted">
          {quiz.message}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {phase === "asking" && (
          <>
            <button onClick={() => void session.check()} className={PRIMARY}>
              Check my answer
            </button>
            {question?.hint && !quiz.hintShown && (
              <button onClick={() => session.hint()} className={SECONDARY}>
                Hint
              </button>
            )}
            {!quiz.revealed && (
              <button onClick={() => session.reveal()} className={SECONDARY}>
                Show answer
              </button>
            )}
            <button onClick={() => void session.next()} className={SECONDARY}>
              Skip
            </button>
          </>
        )}
        {phase === "grading" && (
          <span role="status" className="flex items-center gap-2 text-ink-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Checking…
          </span>
        )}
        {phase === "self" && (
          <>
            <span className="w-full text-ink-muted">
              Compare with the model answer. Did you have it?
            </span>
            <button onClick={() => void session.selfGrade(true)} className={SECONDARY}>
              <Check className="size-4 text-check" aria-hidden />I had it
            </button>
            <button onClick={() => void session.selfGrade(false)} className={SECONDARY}>
              <X className="size-4 text-error" aria-hidden />
              Not quite
            </button>
          </>
        )}
        {phase === "done" && (
          <>
            {quiz.status && <StatusChip status={quiz.status} />}
            <button onClick={() => void session.next()} className={`${PRIMARY} ml-auto`}>
              Next question
            </button>
          </>
        )}
        {phase === "finished" && (
          <button onClick={() => void session.stop()} className={SECONDARY}>
            Close
          </button>
        )}
      </div>
    </section>
  );
}

const SECONDARY =
  "inline-flex items-center gap-1.5 rounded-full border border-rule px-3 py-1 hover:border-accent";
const PRIMARY = "rounded-full bg-ink px-3 py-1 font-medium text-paper";
