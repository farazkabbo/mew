"use client";

import type { ReviewItem } from "@mew/shared";
import { Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { QuickCheck } from "../moments/QuickCheck";
import { useMomentChecks } from "../moments/store";
import { coursesApi, CourseApiError, formatDue, quizHref } from "./api";
import { CourseShell } from "./CourseShell";
import { SkillsToRecheck } from "./SkillsToRecheck";

/**
 * What's due for review across all courses (FSRS), grouped by course, with a quiz per course;
 * the check questions of moments saved from the screen (K8 §4.7) and of "quiz me on this" (S6),
 * as a Quick check; and the skills learned in coach mode, with their re-checks (S5).
 */
export function ReviewApp() {
  const router = useRouter();
  const checks = useMomentChecks((s) => s.checks);
  const openQuickCheck = useMomentChecks((s) => s.openQuickCheck);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  useEffect(() => {
    void useMomentChecks.getState().load(true);
  }, []);
  const momentsDue = (checks ?? []).filter((c) => Date.parse(c.dueAt) <= now.getTime()).length;
  // K8 §4.7: exam dates still take priority. With one close, its course's reviews come first.
  const exam = useMomentChecks((s) => s.exam);
  const moments = (
    <section
      aria-label="Saved moments"
      data-testid="review-moments"
      className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-rule bg-paper-raised p-4"
    >
      <span>
        <span className="font-serif text-2xl">From what you saved</span>
        <span className="block text-sm text-ink-muted">
          {momentsDue === 1 ? "1 check" : `${momentsDue} checks`} due from moments you saved and
          quizzes on your screen.
          {exam &&
            ` Your ${exam.title} exam is ${exam.daysLeft === 0 ? "today" : exam.daysLeft === 1 ? "tomorrow" : `in ${exam.daysLeft} days`}, so its reviews come first.`}
        </span>
      </span>
      <button
        type="button"
        onClick={() => openQuickCheck()}
        className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-paper"
      >
        <Sparkles className="size-4" aria-hidden />
        Quick check
      </button>
    </section>
  );

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
  if (exam) courses.set(exam.courseId, { title: exam.title, items: [] }); // first in the map
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
      {momentsDue > 0 && !exam && moments}
      <QuickCheck onReplay={(clipId) => router.push(`/notebook?moment=${clipId}`)} />
      <SkillsToRecheck now={now} />
      {items?.length === 0 && momentsDue === 0 && (
        <p className="rounded-2xl border border-rule bg-paper-raised p-6">
          Nothing is due right now. Open a lesson or{" "}
          <Link href="/courses" className="underline hover:text-accent">
            pick a course
          </Link>{" "}
          to start something new.
        </p>
      )}
      <div className="space-y-8">
        {[...courses]
          .filter(([, group]) => group.items.length > 0)
          .map(([courseId, group]) => (
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
      {momentsDue > 0 && exam && <div className="mt-8">{moments}</div>}
    </CourseShell>
  );
}
