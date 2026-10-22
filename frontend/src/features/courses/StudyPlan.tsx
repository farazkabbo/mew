"use client";

import {
  type ConceptProgress,
  type CourseDetail,
  localDate,
  planExam,
  progressFor,
} from "@mew/shared";
import { NotebookPen, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { coursesApi, formatDue, formatPages, notebookHref, quizHref } from "./api";
import { ExamPlanView } from "./ExamPlanView";
import { StatusChip } from "./StatusChip";

/**
 * The confirmed plan: concepts in order with their status and next review, what each needs
 * first, links to their lessons, and (with an exam date) the days until the exam.
 */
export function StudyPlan({
  detail,
  onChange,
}: {
  detail: CourseDetail;
  onChange(detail: CourseDetail): void;
}) {
  const { course, concepts, edges } = detail;
  const [known, setKnown] = useState<ConceptProgress[] | null>(null);
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    coursesApi.progress(course.id).then(
      (p) => !cancelled && setKnown(p.concepts),
      () => !cancelled && setKnown([]), // no progress yet is shown as "not started"
    );
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  const ids = useMemo(() => concepts.map((c) => c.id), [concepts]);
  const progress = useMemo(() => progressFor(ids, known ?? []), [ids, known]);
  const plan = useMemo(
    () =>
      course.exam_date
        ? planExam({ orderedIds: ids, progress, examDate: course.exam_date, today: localDate(now) })
        : null,
    [course.exam_date, ids, progress, now],
  );
  const titles = new Map(concepts.map((c) => [c.id, c.title]));
  const counts = { checked: 0, revisit: 0 };
  for (const p of progress.values()) {
    if (p.status === "checked") counts.checked++;
    if (p.status === "revisit") counts.revisit++;
  }

  return (
    <section aria-label="Study plan">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-ink-muted" data-testid="plan-summary">
          {concepts.length} concepts · {counts.checked} checked
          {counts.revisit > 0 && ` · ${counts.revisit} to revisit`}
          {plan &&
            ` · exam ${plan.daysLeft > 0 ? `in ${plan.daysLeft} day${plan.daysLeft === 1 ? "" : "s"}` : plan.daysLeft === 0 ? "today" : "passed"}`}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link
            href={quizHref(course)}
            className="inline-flex items-center gap-2 rounded-full border border-rule px-5 py-2 text-sm font-medium hover:border-accent"
          >
            <Sparkles className="size-4 text-tutor" aria-hidden />
            Quiz me
          </Link>
          <Link
            href={notebookHref(course)}
            className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
          >
            <NotebookPen className="size-4" aria-hidden />
            Open the course notebook
          </Link>
        </div>
      </div>

      <ExamDate detail={detail} onChange={onChange} />
      {plan && plan.daysLeft >= 0 && known && <ExamPlanView plan={plan} concepts={concepts} />}

      <ol className="mt-6 divide-y divide-rule border-y border-rule">
        {concepts.map((concept, index) => {
          const needs = edges
            .filter((e) => e.to_concept === concept.id)
            .map((e) => titles.get(e.from_concept))
            .filter(Boolean);
          const state = progress.get(concept.id);
          return (
            <li key={concept.id} data-testid="plan-concept" className="flex gap-4 py-4">
              <span className="w-6 shrink-0 text-right text-sm text-ink-muted tabular-nums">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <Link
                  href={`/courses/${course.id}/concepts/${concept.id}`}
                  className="font-medium hover:text-accent"
                >
                  {concept.title}
                </Link>
                <p className="text-sm text-ink-muted">
                  {[
                    needs.length ? `Needs: ${needs.join(", ")}` : null,
                    concept.source_pages.length ? formatPages(concept.source_pages) : null,
                    state?.due && state.attempts > 0 ? `review ${formatDue(state.due, now)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ") || concept.summary}
                </p>
              </div>
              {known && state && <StatusChip status={state.status} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** The exam date, editable after the scope review too. */
function ExamDate({ detail, onChange }: { detail: CourseDetail; onChange(d: CourseDetail): void }) {
  const [error, setError] = useState<string | null>(null);
  const save = (value: string) => {
    setError(null);
    coursesApi
      .update(detail.course.id, { exam_date: value || null })
      .then(onChange, () => setError("Couldn't save the exam date."));
  };
  return (
    <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        <span className="text-ink-muted">Exam date</span>
        <input
          type="date"
          defaultValue={detail.course.exam_date ?? ""}
          onChange={(e) => save(e.target.value)}
          className="rounded-lg border border-rule bg-paper px-3 py-1.5 outline-none focus:border-accent"
        />
      </label>
      {error && (
        <span role="alert" className="text-error">
          {error}
        </span>
      )}
    </div>
  );
}
