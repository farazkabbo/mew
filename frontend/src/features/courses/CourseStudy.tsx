"use client";

import type { CourseDetail } from "@mew/shared";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { coursesApi, CourseApiError } from "./api";
import { StatusPill } from "./CourseShell";
import { ScopeReview } from "./ScopeReview";
import { StudyPlan } from "./StudyPlan";

const POLL_MS = 1500;

/**
 * A course's study view (docs/NEB_APP_UI.md decision U26): progress while it's built, then the
 * scope review, then the study plan. It's a notebook's Study tab; `inNotebook` leaves out the
 * way back to the notebook it's already in.
 */
export function CourseStudy({
  id,
  inNotebook = false,
  onQuiz,
  onRemoved,
}: {
  id: string;
  inNotebook?: boolean;
  /** Quiz me, in the notebook it's shown in. */
  onQuiz?: () => void;
  onRemoved(): void;
}) {
  const [detail, setDetail] = useState<CourseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      coursesApi.get(id).then(
        (next) => {
          setDetail(next);
          setError(null);
        },
        (e: unknown) =>
          setError(e instanceof CourseApiError ? e.message : "Couldn't load this course."),
      ),
    [id],
  );

  useEffect(() => {
    let cancelled = false;
    coursesApi.get(id).then(
      (next) => !cancelled && setDetail(next),
      (e: unknown) =>
        !cancelled &&
        setError(e instanceof CourseApiError ? e.message : "Couldn't load this course."),
    );
    return () => {
      cancelled = true;
    };
  }, [id]);

  // While the server builds the course, check back every moment.
  const status = detail?.course.status;
  useEffect(() => {
    if (status !== "processing") return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, load]);

  const remove = async () => {
    await coursesApi.remove(id).catch(() => undefined);
    onRemoved();
  };

  if (!detail) {
    return (
      <p role={error ? "alert" : undefined} className="text-sm text-muted">
        {error ?? "Loading…"}
      </p>
    );
  }

  const { course } = detail;
  return (
    <div className="flex flex-col gap-6" data-testid="course-study">
      {course.status !== "ready" && (
        <p className="flex flex-wrap items-center gap-3 text-muted">
          <StatusPill status={course.status} />
          {course.status_detail && <span className="text-sm">{course.status_detail}</span>}
        </p>
      )}
      {course.status === "processing" && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-2xl border border-line bg-paper-hi p-6"
        >
          <Loader2 className="size-5 animate-spin text-ink" aria-hidden />
          <p>Reading your material and finding the key concepts…</p>
        </div>
      )}
      {course.status === "failed" && (
        <div className="rounded-2xl border border-line bg-paper-hi p-6">
          <p>{course.status_detail ?? "This course couldn't be built."}</p>
          <button
            onClick={() => void remove()}
            className="mt-4 rounded-full border border-line px-4 py-1.5 text-sm hover:border-danger"
          >
            Delete and try another file
          </button>
        </div>
      )}
      {course.status === "review" && <ScopeReview detail={detail} onSaved={setDetail} />}
      {course.status === "ready" && (
        <StudyPlan
          detail={detail}
          onChange={setDetail}
          inNotebook={inNotebook}
          {...(onQuiz && { onQuiz })}
        />
      )}
    </div>
  );
}
