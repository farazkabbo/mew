import type { Concept, ExamPlan } from "@mew/shared";
import { CalendarDays } from "lucide-react";

const DAY_NAMES = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** The days left before the exam, each with what to work on (brief §9). */
export function ExamPlanView({ plan, concepts }: { plan: ExamPlan; concepts: readonly Concept[] }) {
  const titles = new Map(concepts.map((c) => [c.id, c.title]));
  const names = (ids: readonly string[]) => ids.map((id) => titles.get(id) ?? "").join(", ");
  const days = plan.days.filter((d) => d.learn.length || d.review.length || d.finalReview);

  return (
    <section aria-label="Plan until the exam" className="mt-8 rounded-2xl border border-line p-5">
      <h2 className="flex items-center gap-2 font-serif text-xl">
        <CalendarDays className="size-5 text-ink" aria-hidden />
        Until the exam
      </h2>
      {days.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          Everything is checked. Keep an eye on the reviews as they come due.
        </p>
      ) : (
        <ol className="mt-3 space-y-3">
          {days.map((day, i) => (
            <li key={day.date} data-testid="plan-day" className="flex gap-4 text-sm">
              <span className="w-24 shrink-0 font-medium">
                {i === 0 && day.date === plan.days[0]?.date
                  ? "Today"
                  : DAY_NAMES.format(new Date(`${day.date}T00:00:00Z`))}
              </span>
              <span className="min-w-0 flex-1 text-muted">
                {[
                  day.learn.length ? `Work on: ${names(day.learn)}` : null,
                  day.review.length ? `Review: ${names(day.review)}` : null,
                  day.finalReview ? "Final review of everything" : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
