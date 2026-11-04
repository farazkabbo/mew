"use client";

import {
  type ConceptProgress,
  type Course,
  type CourseDetail,
  type Notebook,
  NotebookTree,
  type ReviewItem,
} from "@mew/shared";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { subtreeIds } from "../moments/moments";
import { QuickCheck } from "../moments/QuickCheck";
import { useMomentChecks } from "../moments/store";
import { NotebookDb } from "../notebook/db";
import { NotebookRepository } from "../notebook/repository";
import { COLORS, PICKABLE_COLORS } from "../notebook/tree/node-style";
import { coursesApi, CourseApiError } from "./api";
import { ReviewFolders } from "./ReviewFolders";
import { ReviewHeader } from "./ReviewHeader";
import { fallbackColor, folderRows, notebookFolders, orderFolders } from "./review-folders";
import { SkillsToRecheck } from "./SkillsToRecheck";
import { UpNextCard } from "./UpNextCard";

type Loaded = { course: Course; detail: CourseDetail; progress: ConceptProgress[] };

const PALETTE = PICKABLE_COLORS.map((c) => COLORS[c].hex);

/**
 * What's due for another look (docs/NEB_APP_UI.md decisions U25 and U26, boards 7 and 8): on the
 * left, the checks of moments saved from the screen (K8 §4.7) and of "quiz me on this" (S6) as an
 * index card, and the skills learned in coach mode with their re-checks (S5); on the right, each
 * notebook as a file folder with its course's concepts by status (FSRS, M8), a quiz, and the
 * checks due from what was saved in it.
 */
export function ReviewApp({ userId, name }: { userId: string; name: string | null }) {
  const router = useRouter();
  const checks = useMomentChecks((s) => s.checks);
  const openQuickCheck = useMomentChecks((s) => s.openQuickCheck);
  // K8 §4.7: exam dates still take priority. With one close, its course's folder comes first.
  const exam = useMomentChecks((s) => s.exam);
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [now] = useState(() => new Date());

  useEffect(() => {
    void useMomentChecks.getState().load(true);
  }, []);
  const momentsDue = (checks ?? []).filter((c) => Date.parse(c.dueAt) <= now.getTime()).length;

  useEffect(() => {
    let cancelled = false;
    const failed = (e: unknown) =>
      !cancelled &&
      setError(e instanceof CourseApiError ? e.message : "Couldn't load your reviews.");
    coursesApi.dueReviews().then((queue) => !cancelled && setItems(queue.items), failed);
    coursesApi
      .list()
      .then((courses) =>
        Promise.all(
          courses.map((course) =>
            Promise.all([coursesApi.get(course.id), coursesApi.progress(course.id)]).then(
              ([detail, progress]) => ({ course, detail, progress: progress.concepts }),
              () => null, // one course failing still shows the others
            ),
          ),
        ),
      )
      .then((all) => !cancelled && setLoaded(all.filter((x): x is Loaded => x !== null)), failed);
    // The folders are this device's notebooks: their names, colours and what's saved in them.
    const db = new NotebookDb(userId);
    new NotebookRepository(db).listNotebooks().then(
      (list) => !cancelled && setNotebooks(list),
      () => undefined,
    );
    return () => {
      cancelled = true;
      db.close();
    };
  }, [userId]);

  const tree = useMemo(() => new NotebookTree(notebooks), [notebooks]);
  const folders = useMemo(() => {
    if (!loaded || !items) return null;
    const quiz = new Map<string, number>();
    for (const item of items) quiz.set(item.courseId, (quiz.get(item.courseId) ?? 0) + 1);
    // Checks due now, by the notebook their moment was saved in.
    const checksByNotebook = new Map<string, number>();
    for (const check of checks ?? []) {
      if (!check.nodeId || Date.parse(check.dueAt) > now.getTime()) continue;
      const root = tree.path(check.nodeId)[0]?.id;
      if (root) checksByNotebook.set(root, (checksByNotebook.get(root) ?? 0) + 1);
    }
    const folders = notebookFolders(
      loaded.map(({ course, detail, progress }) => ({
        id: course.id,
        title: course.title,
        rows: folderRows(detail.concepts, progress, now),
        quiz: quiz.get(course.id) ?? 0,
      })),
      tree.children(null).map((n) => ({
        id: n.id,
        title: n.title,
        color: COLORS[n.color ?? "slate"].hex,
        courseId: n.courseId ?? null,
      })),
      checksByNotebook,
      (courseId) => fallbackColor(courseId, PALETTE),
    );
    return orderFolders(folders, exam?.courseId ?? null);
  }, [loaded, items, tree, checks, now, exam]);

  return (
    <div className="min-h-dvh bg-desk text-[15px] leading-[1.45] text-ink">
      <ReviewHeader name={name} />
      <main className="mx-auto box-border max-w-[1160px] px-10 pt-12 pb-20 max-sm:px-4">
        <div className="mb-10">
          <h1 className="font-serif text-[72px] leading-none tracking-[-0.01em] max-sm:text-[52px]">
            Review
          </h1>
          <p className="mt-3 max-w-[520px] text-base text-muted">
            What&apos;s due for another look. Things come back sooner when you miss them, later when
            they stay.
          </p>
        </div>
        <QuickCheck onReplay={(clipId) => router.push(`/notebook?moment=${clipId}`)} />
        <div className="flex flex-wrap items-start gap-10">
          <section
            aria-labelledby="review-up-next"
            className="flex max-w-[420px] min-w-0 flex-[1_1_340px] flex-col gap-6"
          >
            <h2
              id="review-up-next"
              className="text-xs font-semibold tracking-[0.12em] text-muted uppercase"
            >
              Up next
            </h2>
            <UpNextCard due={momentsDue} exam={exam} onStart={() => openQuickCheck()} />
            <SkillsToRecheck now={now} />
          </section>
          <section
            aria-labelledby="review-by-course"
            className="flex min-w-0 flex-[999_1_560px] flex-col gap-4"
          >
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
              <h2
                id="review-by-course"
                className="text-xs font-semibold tracking-[0.12em] text-muted uppercase"
              >
                By course
              </h2>
              {folders && folders.length > 0 && (
                <span className="text-[13px] text-muted">
                  {folders.length === 1 ? "1 course" : `${folders.length} courses`} · most due first
                </span>
              )}
            </div>
            {error && (
              <p role="alert" className="text-sm text-muted">
                {error}
              </p>
            )}
            {!folders && !error && <p className="text-muted">Loading…</p>}
            {folders?.length === 0 && (
              <p className="rounded-xl border border-line bg-paper p-6">
                Nothing is due right now. Add course material to a notebook on{" "}
                <Link href="/desk" className="underline hover:text-ink">
                  your desk
                </Link>{" "}
                and open a lesson to start something new.
              </p>
            )}
            {folders && folders.length > 0 && (
              <>
                <ReviewFolders
                  courses={folders}
                  onQuickCheck={(id) => openQuickCheck({ nodeIds: [...subtreeIds(tree, id)] })}
                />
                <p className="mt-2 text-[13px] text-muted">
                  A concept counts as checked once you get it right on your own. Hints and shown
                  answers bring it back sooner.
                </p>
              </>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
