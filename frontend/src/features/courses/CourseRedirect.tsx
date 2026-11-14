"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { coursesApi, CourseApiError, studyHref } from "./api";
import { CourseShell } from "./CourseShell";

/**
 * `/courses/<id>` (decision U26): the course's notebook on its Study tab. The notebook is found,
 * or made for a course that has none yet, by `/notebook?course=…`.
 */
export function CourseRedirect({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    coursesApi.get(id).then(
      ({ course }) => !cancelled && router.replace(studyHref(course)),
      (e: unknown) =>
        !cancelled &&
        setError(e instanceof CourseApiError ? e.message : "Couldn't open this course."),
    );
    return () => {
      cancelled = true;
    };
  }, [id, router]);
  return (
    <CourseShell back={{ href: "/desk", label: "Desk" }} title="Course">
      <p role={error ? "alert" : "status"} className="text-sm text-muted">
        {error ?? "Opening its notebook…"}
      </p>
    </CourseShell>
  );
}
