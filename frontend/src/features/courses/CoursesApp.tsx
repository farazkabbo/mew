"use client";

import type { Course } from "@mew/shared";
import { FileUp, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

import { coursesApi, CourseApiError } from "./api";
import { CourseShell, StatusPill } from "./CourseShell";

const MAX_BYTES = 15 * 1024 * 1024;

/** The student's courses, and a form to build a new one from a PDF. */
export function CoursesApp() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    coursesApi
      .list()
      .then(setCourses)
      .catch((e: unknown) => {
        setCourses([]);
        setError(e instanceof CourseApiError ? e.message : "Couldn't load your courses.");
      });
  }, []);

  const choose = (picked: File | null) => {
    setError(null);
    if (picked && picked.size > MAX_BYTES) {
      setError("That PDF is larger than 15 MB.");
      return;
    }
    setFile(picked);
    if (picked && !title) setTitle(picked.name.replace(/\.pdf$/i, "").slice(0, 120));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!file || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const course = await coursesApi.create(file, title.trim());
      router.push(`/courses/${course.id}`);
    } catch (e) {
      setError(e instanceof CourseApiError ? e.message : "Couldn't upload that PDF.");
      setBusy(false);
    }
  };

  return (
    <CourseShell
      back={{ href: "/notebook", label: "Notebook" }}
      title="Courses"
      subtitle="Turn a chapter, your notes or a syllabus into a study plan the tutor can draw on."
    >
      <form
        onSubmit={(e) => void submit(e)}
        aria-label="New course"
        className="rounded-2xl border border-rule bg-paper-raised p-6"
      >
        <h2 className="font-serif text-2xl">New course</h2>
        <label className="mt-5 flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-rule px-4 py-8 text-center text-sm text-ink-muted hover:border-accent focus-within:border-accent">
          <FileUp className="size-6" aria-hidden />
          <span>{file ? file.name : "Choose a PDF (up to 15 MB)"}</span>
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="sr-only"
            onChange={(e) => choose(e.target.files?.[0] ?? null)}
          />
        </label>
        <label className="mt-4 block text-sm">
          <span className="text-ink-muted">Course title</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            required
            className="mt-1 w-full rounded-lg border border-rule bg-paper px-3 py-2 outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={!file || !title.trim() || busy}
          className="mt-5 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-2 text-sm font-medium text-paper disabled:opacity-40"
        >
          {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Build course
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-error">
            {error}
          </p>
        )}
      </form>

      <section aria-label="Your courses" className="mt-12">
        <h2 className="font-serif text-2xl">Your courses</h2>
        {courses === null ? (
          <p className="mt-4 text-sm text-ink-muted">Loading…</p>
        ) : courses.length === 0 ? (
          <p className="mt-4 text-sm text-ink-muted">No courses yet.</p>
        ) : (
          <ul className="mt-4 divide-y divide-rule border-y border-rule">
            {courses.map((course) => (
              <li key={course.id}>
                <Link
                  href={`/courses/${course.id}`}
                  className="flex items-center justify-between gap-4 py-4 hover:text-accent"
                >
                  <span className="font-medium">{course.title}</span>
                  <StatusPill status={course.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </CourseShell>
  );
}
