import type { CourseDetail } from "@mew/shared";
import { NotebookPen } from "lucide-react";
import Link from "next/link";

import { formatPages, notebookHref } from "./api";

/** The confirmed plan: concepts in order, what each needs first, and links to their lessons. */
export function StudyPlan({ detail }: { detail: CourseDetail }) {
  const { course, concepts, edges } = detail;
  const titles = new Map(concepts.map((c) => [c.id, c.title]));
  const daysLeft = course.exam_date ? daysUntil(course.exam_date) : null;

  return (
    <section aria-label="Study plan">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="text-ink-muted">
          {concepts.length} concepts
          {daysLeft !== null &&
            ` · exam ${daysLeft > 0 ? `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}` : daysLeft === 0 ? "today" : "passed"}`}
        </p>
        <Link
          href={notebookHref(course)}
          className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
        >
          <NotebookPen className="size-4" aria-hidden />
          Open the course notebook
        </Link>
      </div>
      <ol className="mt-6 divide-y divide-rule border-y border-rule">
        {concepts.map((concept, index) => {
          const needs = edges
            .filter((e) => e.to_concept === concept.id)
            .map((e) => titles.get(e.from_concept))
            .filter(Boolean);
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
                  ]
                    .filter(Boolean)
                    .join(" · ") || concept.summary}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function daysUntil(isoDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exam = new Date(`${isoDate}T00:00:00`);
  return Math.round((exam.getTime() - today.getTime()) / 86_400_000);
}
