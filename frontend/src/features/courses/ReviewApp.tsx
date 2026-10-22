"use client";

import type { ReviewItem } from "@mew/shared";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { coursesApi, CourseApiError, formatDue, quizHref } from "./api";
import { CourseShell } from "./CourseShell";

/** What's due for review across all courses (FSRS), grouped by course, with a quiz per course. */
export function ReviewApp() {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  useEffect(() => {
    let cancelled = false;
    coursesApi.dueReviews().then(
      (queue) => !cancelled && setItems(queue.items),
      (e: unknown) =>
        !cancelled &&
        setError(e instanceof CourseApiError ? e.message : "Couldn't load your reviews."),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const courses = new Map<string, { title: string; items: ReviewItem[] }>();
  for (const item of items ?? []) {
    const group = courses.get(item.courseId) ?? { title: item.courseTitle, items: [] };
    group.items.push(item);
    courses.set(item.courseId, group);
  }

  return (
    <CourseShell
      back={{ href: "/notebook", label: "Notebook" }}
      title="Review"
      subtitle="Concepts due for another look, spaced so they stick."
    >
      {error && (
        <p role="alert" className="text-sm text-error">
          {error}
        </p>
      )}
      {!items && !error && <p className="text-ink-muted">Loading…</p>}
      {items?.length === 0 && (
        <p className="rounded-2xl border border-rule bg-paper-raised p-6">
          Nothing is due right now. Open a lesson or{" "}
          <Link href="/courses" className="underline hover:text-accent">
            pick a course
          </Link>{" "}
          to start something new.
        </p>
      )}
      <div className="space-y-8">
        {[...courses].map(([courseId, group]) => (
          <section key={courseId} aria-label={group.title} data-testid="review-course">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-serif text-2xl">
                <Link href={`/courses/${courseId}`} className="hover:text-accent">
                  {group.title}
                </Link>
              </h2>
              <Link
                href={quizHref({ id: courseId, title: group.title })}
                className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper"
              >
                <Sparkles className="size-4" aria-hidden />
                Quiz me ({group.items.length})
              </Link>
            </div>
            <ul className="mt-3 divide-y divide-rule border-y border-rule">
              {group.items.map((item) => (
                <li key={item.conceptId} data-testid="review-item" className="flex gap-4 py-3">
                  <Link
                    href={`/courses/${courseId}/concepts/${item.conceptId}`}
                    className="min-w-0 flex-1 font-medium hover:text-accent"
                  >
                    {item.conceptTitle}
                  </Link>
                  <span className="text-sm text-ink-muted">
                    {item.isNew ? "new · not practised yet" : formatDue(item.due, now)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </CourseShell>
  );
}
