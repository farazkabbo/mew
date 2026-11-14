"use client";

import type { CourseDetail } from "@mew/shared";
import { FileQuestion, FileX } from "lucide-react";
import type { ReactNode } from "react";
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
  const deleteButton = (
    <button
      type="button"
      onClick={() => void remove()}
      className="mt-6 h-11 rounded-full border border-line px-[22px] text-[15px] font-semibold text-danger hover:border-danger"
    >
      Delete and try another file
    </button>
  );
  return (
    <div className="flex flex-col gap-6" data-testid="course-study">
      {course.status === "review" && (
        <p className="flex flex-wrap items-center gap-3 text-muted">
          <StatusPill status={course.status} />
          {course.status_detail && <span className="text-sm">{course.status_detail}</span>}
        </p>
      )}
      {course.status === "processing" && <Building />}
      {course.status === "failed" && (
        <EmptyState
          icon={<FileX className="size-7" strokeWidth={1.8} />}
          title="This course couldn't be built."
          text={course.status_detail ?? "Your notebook and its pages aren't affected."}
        >
          {deleteButton}
        </EmptyState>
      )}
      {course.status === "review" && <ScopeReview detail={detail} onSaved={setDetail} />}
      {course.status === "ready" && detail.concepts.length === 0 && (
        <EmptyState
          icon={<FileQuestion className="size-7" strokeWidth={1.8} />}
          title="No concepts in this course yet."
          text="neb didn't find concepts in this material. Try another file."
        >
          {deleteButton}
        </EmptyState>
      )}
      {course.status === "ready" && detail.concepts.length > 0 && (
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

/** While neb reads the material: its spinner and voice, over the shape of the list to come. */
export function Building() {
  return (
    <div role="status">
      <div className="flex flex-col items-center pt-6 pb-2 text-center">
        <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden className="animate-spin">
          <circle cx="22" cy="22" r="18" fill="none" stroke="var(--neb-wash)" strokeWidth="4" />
          <path
            d="M22 4a18 18 0 0 1 18 18"
            fill="none"
            stroke="var(--neb)"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </svg>
        <p className="neb-voice mt-4 text-base">
          reading your material and finding the key concepts…
        </p>
        <p className="mt-1.5 text-sm text-muted">You can keep writing while neb reads.</p>
      </div>
      <div aria-hidden className="mt-7 overflow-hidden rounded-xl bg-paper-hi">
        {["48%", "36%", "56%", "40%", "50%", "32%"].map((width, i) => (
          <div
            key={width + i}
            className="flex h-[68px] items-center gap-3.5 border-b border-line px-[18px]"
            style={{ opacity: 1 - i * 0.15 }}
          >
            <span className="size-8 rounded-full bg-sunk" />
            <span className="flex flex-1 flex-col gap-2">
              <span className="h-3 rounded-md bg-sunk" style={{ width }} />
              <span className="h-2 w-[120px] rounded bg-sunk" />
            </span>
            <span className="h-6 w-[72px] rounded-full bg-sunk" />
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  text,
  children,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center pt-12 pb-8 text-center">
      <span aria-hidden className="grid size-16 place-items-center rounded-2xl bg-sunk text-muted">
        {icon}
      </span>
      <h2 className="mt-5 font-serif text-[34px] leading-[1.1]">{title}</h2>
      <p className="mt-2 max-w-[460px] text-[15px] text-muted">{text}</p>
      {children}
    </div>
  );
}
