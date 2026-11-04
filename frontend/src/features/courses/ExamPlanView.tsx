"use client";

import type { CourseDetail, ExamPlan } from "@mew/shared";
import { useState } from "react";

import { coursesApi } from "./api";

const DAY_NAMES = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * The exam plan card beside the concepts (docs/NEB_APP_UI.md decision U28, board Study): the exam
 * date, editable, and with one set, the days left with what to work on (brief §9): today on a
 * sticky note, the eve dashed, the exam day in ink.
 */
export function ExamPlanCard({
  detail,
  onChange,
  plan,
}: {
  detail: CourseDetail;
  onChange(detail: CourseDetail): void;
  plan: ExamPlan | null;
}) {
  const [error, setError] = useState<string | null>(null);
  const titles = new Map(detail.concepts.map((c) => [c.id, c.title]));
  const names = (ids: readonly string[]) => ids.map((id) => titles.get(id) ?? "").join(", ");
  const days = plan?.days.filter((d) => d.learn.length || d.review.length || d.finalReview) ?? [];
  const save = (value: string) => {
    setError(null);
    coursesApi
      .update(detail.course.id, { exam_date: value || null })
      .then(onChange, () => setError("Couldn't save the exam date."));
  };

  return (
    <aside
      aria-labelledby="exam-plan"
      className="max-w-[340px] min-w-0 flex-[1_1_280px] rounded-xl bg-paper-hi p-[22px] shadow-sh-2"
    >
      <h2 id="exam-plan" className="font-serif text-[26px] leading-none">
        Exam plan
      </h2>
      <label className="mt-4 flex flex-col gap-1.5 text-[13px] text-muted">
        Exam date
        <input
          type="date"
          defaultValue={detail.course.exam_date ?? ""}
          onChange={(e) => save(e.target.value)}
          className="h-10 rounded-[10px] border border-line bg-paper px-3 text-sm font-medium text-ink outline-none focus:border-ink"
        />
      </label>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-muted">
          {error}
        </p>
      )}
      {!plan ? (
        <p className="mt-3.5 text-[13px] text-muted">
          Set it and neb spreads what&apos;s left over the days before it.
        </p>
      ) : days.length === 0 ? (
        <p className="mt-3.5 text-sm text-muted">
          Everything is checked. Keep an eye on the reviews as they come due.
        </p>
      ) : (
        <section aria-label="Plan until the exam">
          <ol className="mt-[18px] flex flex-col">
            {days.map((day, i) => {
              const today = i === 0 && day.date === plan.days[0]?.date;
              return (
                <li
                  key={day.date}
                  data-testid="plan-day"
                  className={`flex items-baseline gap-2.5 rounded-lg px-2.5 py-[9px] ${today ? "bg-note" : day.finalReview ? "border border-dashed border-line" : ""}`}
                >
                  <span className="w-14 flex-none text-[13px] font-semibold tabular-nums">
                    {today ? "Today" : DAY_NAMES.format(new Date(`${day.date}T00:00:00Z`))}
                  </span>
                  <span className="min-w-0 flex-1 text-sm">
                    {[
                      day.learn.length ? `Work on: ${names(day.learn)}` : null,
                      day.review.length ? `Review: ${names(day.review)}` : null,
                      day.finalReview ? "Final review of everything" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              );
            })}
            {detail.course.exam_date && (
              <li
                data-testid="plan-exam"
                className="mt-1 flex items-baseline gap-2.5 rounded-lg bg-ink px-2.5 py-[9px] text-paper"
              >
                <span className="w-14 flex-none text-[13px] font-semibold tabular-nums">
                  {DAY_NAMES.format(new Date(`${detail.course.exam_date.slice(0, 10)}T00:00:00Z`))}
                </span>
                <span className="min-w-0 flex-1 text-sm">Exam</span>
              </li>
            )}
          </ol>
          <p className="mt-3.5 text-xs text-muted">
            Revisit first, then what&apos;s left in course order. The eve is a final review.
          </p>
        </section>
      )}
    </aside>
  );
}
