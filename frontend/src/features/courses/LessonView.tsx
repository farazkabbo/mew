"use client";

import type { Concept, ConceptProgress, CourseDetail, Lesson } from "@mew/shared";
import { Loader2, NotebookPen, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { coursesApi, CourseApiError, formatPages, notebookHref, quizHref } from "./api";
import { CourseShell } from "./CourseShell";
import { PracticeCard } from "./PracticeCard";
import { StatusChip } from "./StatusChip";

/** A concept's lesson: explanation, worked example and practice, grounded in the course. */
export function LessonView({ courseId, conceptId }: { courseId: string; conceptId: string }) {
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ConceptProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fail = (e: unknown) => {
      if (!cancelled)
        setError(e instanceof CourseApiError ? e.message : "Couldn't load the lesson.");
    };
    coursesApi
      .get(courseId)
      .then((d) => !cancelled && setDetail(d))
      .catch(fail);
    coursesApi
      .lesson(courseId, conceptId)
      .then((l) => {
        if (cancelled) return;
        setLesson(l);
        // Reading the lesson counts as exploring the concept (and starts its reviews).
        void coursesApi.explored(courseId, conceptId).catch(() => undefined);
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
  }, [courseId, conceptId]);

  const concept: Concept | undefined = detail?.concepts.find((c) => c.id === conceptId);
  const back = { href: `/courses/${courseId}`, label: detail?.course.title ?? "Course" };

  return (
    <CourseShell
      back={back}
      title={concept?.title ?? "Lesson"}
      subtitle={
        <span className="flex flex-wrap items-center gap-3">
          {progress && <StatusChip status={progress.status} />}
          {concept?.summary}
        </span>
      }
    >
      {error && (
        <p role="alert" className="text-sm text-muted">
          {error}
        </p>
      )}
      {!lesson && !error && (
        <p role="status" className="flex items-center gap-2 text-muted">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Writing your lesson from the course material…
        </p>
      )}
      {lesson && (
        <article className="space-y-10">
          <section>
            <h2 className="font-serif text-2xl">Explanation</h2>
            <Paragraphs text={lesson.explanation} />
            {lesson.pages.length > 0 && (
              <p className="mt-3 text-sm text-muted">From {formatPages(lesson.pages)}</p>
            )}
          </section>
          {lesson.worked_example && (
            <section>
              <h2 className="font-serif text-2xl">Worked example</h2>
              <p className="mt-3 whitespace-pre-wrap rounded-xl border border-line bg-paper-hi p-5 leading-relaxed">
                {lesson.worked_example}
              </p>
            </section>
          )}
          {lesson.practice.length > 0 && (
            <section>
              <h2 className="font-serif text-2xl">Practice</h2>
              <ol className="mt-4 space-y-5">
                {lesson.practice.map((q, i) => (
                  <PracticeCard
                    key={i}
                    courseId={courseId}
                    conceptId={conceptId}
                    index={i}
                    question={q}
                    onRecorded={setProgress}
                  />
                ))}
              </ol>
            </section>
          )}
          {!lesson.generated && (
            <p className="text-sm text-muted">
              This is the summary and the most relevant passage. Full lessons (worked examples and
              practice) are written by the tutor model when it&apos;s configured.
            </p>
          )}
          {detail && (
            <div className="flex flex-wrap gap-2">
              <Link
                href={notebookHref(detail.course)}
                className="inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper"
              >
                <NotebookPen className="size-4" aria-hidden />
                Practise in the notebook
              </Link>
              <Link
                href={quizHref(detail.course)}
                className="inline-flex items-center gap-2 rounded-full border border-line px-5 py-2 text-sm font-medium hover:border-ink"
              >
                <Sparkles className="size-4 text-neb-ink" aria-hidden />
                Quiz me
              </Link>
            </div>
          )}
        </article>
      )}
    </CourseShell>
  );
}

function Paragraphs({ text }: { text: string }) {
  return (
    <div className="mt-3 space-y-3 leading-relaxed">
      {text
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((p, i) => (
          <p key={i}>{p}</p>
        ))}
    </div>
  );
}
