"use client";

import type { CourseDetail } from "@mew/shared";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import { coursesApi, CourseApiError } from "./api";
import { CourseShell, StatusPill } from "./CourseShell";
import { ScopeReview } from "./ScopeReview";
import { StudyPlan } from "./StudyPlan";

const POLL_MS = 1500;

/** One course: progress while it's built, then the scope review, then the study plan. */
export function CourseApp({ id }: { id: string }) {
  const router = useRouter();
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
    router.push("/courses");
  };

  if (!detail) {
    return (
      <CourseShell back={{ href: "/courses", label: "Courses" }} title="Course">
        <p role={error ? "alert" : undefined} className="text-sm text-muted">
          {error ?? "Loading…"}
        </p>
      </CourseShell>
    );
  }

  const { course } = detail;
  return (
    <CourseShell
      back={{ href: "/courses", label: "Courses" }}
      title={course.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-3">
          <StatusPill status={course.status} />
          {course.status_detail && <span className="text-sm">{course.status_detail}</span>}
        </span>
      }
    >
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
      {course.status === "ready" && <StudyPlan detail={detail} onChange={setDetail} />}
    </CourseShell>
  );
}
