"use client";

import {
  chapterProgress,
  type CourseProgress,
  type Notebook,
  type NotebookTree,
  type Page,
  Subject,
  TREE_LIMITS,
} from "@mew/shared";
import { FileText, FileUp, GraduationCap, Plus, Sparkles } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { coursesApi } from "../../courses/api";
import { CourseStudy } from "../../courses/CourseStudy";
import { FileThese } from "../../moments/FileThese";
import { type Moment, subtreeIds } from "../../moments/moments";
import { MomentsList } from "../../moments/MomentsList";
import { useShortcutKeys } from "../../shortcuts/useShortcutKeys";
import { Breadcrumb } from "./Breadcrumb";
import { NodeIcon } from "./node-style";
import { childNoun, plural } from "./tree-labels";

type Props = {
  node: Notebook;
  tree: NotebookTree<Notebook>;
  /** Reads how many pages each node has. */
  loadCounts(ids: readonly string[]): Promise<Map<string, number>>;
  /** This node's own pages ("Loose pages"). */
  pages: readonly Page[];
  now: number;
  onOpen(id: string): void;
  onOpenPage(pageId: string): void;
  onAddChild(): void;
  onAddPage(): void;
  /** K4: "Import PDF" into this node. */
  onImportPdf(): void;
  /** U26: the tab to open on (a course link opens Study). */
  initialTab?: HomeTab;
  /** U26: links the notebook to a course the student already has, or unlinks it (null). */
  onLinkCourse(courseId: string | null): void;
  /** U26: the Study tab's Quiz me, started on the notebook's page. */
  onQuiz(): void;
  /** K8: the moments saved in this node and everything under it, newest first. */
  moments: readonly Moment[];
  /** K8: checks due now on each node (counted up the tree). */
  dueCounts: ReadonlyMap<string, number>;
  onOpenMoment(moment: Moment): void;
  /** K8: a moment's PDF is imported here: open it at the circled words' page. */
  inNeb?(moment: Moment): boolean;
  onOpenInNeb?(moment: Moment): void;
  /** K8: a Quick check of what's due here. */
  onQuickCheck(): void;
  /** K8: the notebook's subject changed (filing compares it with what a moment is about). */
  onSetSubject(subject: Subject | null): void;
  /** K8: this is the student's Unsorted notebook ("File these"). */
  unsorted?: {
    onFile(moment: Moment, nodeId: string): Promise<void>;
    onChoose(moment: Moment): void;
  };
};

const SUBJECT_LABELS: Record<Subject, string> = {
  math: "Maths",
  physics: "Physics",
  chemistry: "Chemistry",
  biology: "Biology",
  history: "History",
  language: "Languages",
  programming: "Programming",
  other: "Other",
};

export type HomeTab = "pages" | "study" | "moments";

/**
 * A notebook's (or chapter's) home (K1, docs/NOTEBOOKS_K.md §2.2): a card per chapter with its
 * page count, when it was last edited and its course progress (when the notebook has a course),
 * its own "Loose pages", and a card to add a chapter.
 *
 * Decision U26 (docs/NEB_APP_UI.md): a notebook is the whole class. Its home has Pages always,
 * Study once it has course material (the course's lessons, plan, exam date and Quiz me), and
 * Moments once something was saved. Until then, one card offers to add the material.
 */
export function NodeHome({
  node,
  tree,
  loadCounts,
  pages,
  now,
  moments,
  dueCounts,
  unsorted,
  initialTab,
  ...actions
}: Props) {
  const keys = useShortcutKeys();
  // Unsorted is where moments wait: they're what it's for, so they come first there.
  const [tab, setTab] = useState<HomeTab>(initialTab ?? (unsorted ? "moments" : "pages"));
  const root = tree.path(node.id)[0] ?? node;
  const children = tree.children(node.id);
  const childIds = children.map((c) => c.id).join(",");
  const [pageCounts, setPageCounts] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    let live = true;
    void loadCounts(childIds ? childIds.split(",") : []).then(
      (counts) => live && setPageCounts(counts),
    );
    return () => {
      live = false;
    };
  }, [childIds, loadCounts]);
  // K4 decision 8: once a PDF's topics are found, a card says so (the import never waits).
  const [topics, setTopics] = useState<"processing" | "review" | null>(null);
  const courseId = root.courseId ?? null;
  // The Study tab shows the course's state itself (and polls it): no card, no second poll.
  const onStudy = tab === "study";
  useEffect(() => {
    if (!courseId || onStudy) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () =>
      void coursesApi
        .get(courseId)
        .then((detail) => {
          const status = detail.course.status;
          if (!live) return;
          setTopics(status === "review" || status === "processing" ? status : null);
          // Still being read: look again shortly (the card updates on its own).
          if (status === "processing") timer = setTimeout(check, 4000);
        })
        .catch(() => undefined);
    check();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [courseId, onStudy]);
  // K1 §2.2: each chapter card shows its course progress (the topics in it that are checked).
  const [progress, setProgress] = useState<CourseProgress | null>(null);
  useEffect(() => {
    if (!courseId) return;
    let live = true;
    void coursesApi
      .progress(courseId)
      .then((read) => live && setProgress(read))
      .catch(() => undefined); // offline: the cards show without it
    return () => {
      live = false;
    };
  }, [courseId]);
  const progressOf = (id: string) =>
    courseId && progress ? chapterProgress(subtreeIds(tree, id), progress) : null;
  const canAdd = tree.depth(node.id) < TREE_LIMITS.maxDepth;
  const isRoot = node.parentId === null;
  const hasStudy = isRoot && courseId !== null;
  const hasMoments = moments.length > 0 || unsorted !== undefined;
  // A tab that went away (the course was removed, the last moment moved) falls back to Pages.
  const shown: HomeTab =
    (tab === "study" && !hasStudy) || (tab === "moments" && !hasMoments) ? "pages" : tab;
  const noun = childNoun(tree, node.id);
  const totalPages = children.reduce((sum, c) => sum + (pageCounts.get(c.id) ?? 0), pages.length);

  return (
    <div className="h-full overflow-y-auto" data-testid="node-home">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 pt-20 pb-28">
        <header className="flex flex-col gap-3">
          <Breadcrumb tree={tree} nodeId={node.id} onOpen={actions.onOpen} />
          <div className="flex items-center gap-3">
            <NodeIcon node={root} className="size-8" />
            <h1 className="font-serif text-4xl tracking-tight">{node.title}</h1>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            <span>
              {plural(children.length, noun)} · {plural(totalPages, "page")}
            </span>
            {node.parentId === null && !unsorted && (
              <label className="inline-flex items-center gap-1">
                <span>Subject</span>
                <select
                  data-testid="notebook-subject"
                  value={node.subject ?? ""}
                  onChange={(event) => {
                    const subject = Subject.safeParse(event.target.value);
                    actions.onSetSubject(subject.success ? subject.data : null);
                  }}
                  className="rounded-md bg-transparent px-1 py-0.5 hover:bg-line/50"
                >
                  <option value="">Not set</option>
                  {Subject.options.map((subject) => (
                    <option key={subject} value={subject}>
                      {SUBJECT_LABELS[subject]}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </p>
        </header>

        {courseId && topics && shown !== "study" && (
          <aside
            data-testid="review-topics"
            className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-paper-hi p-4"
          >
            <span className="text-sm">
              {topics === "review"
                ? "Neb found the topics in your PDF. Check them so it can quiz you and track what you know."
                : "Neb is finding the topics in your PDF. You can write on its pages meanwhile."}
            </span>
            {topics === "review" && (
              <button
                type="button"
                onClick={() => setTab("study")}
                className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper"
              >
                Review topics
              </button>
            )}
          </aside>
        )}

        {(dueCounts.get(node.id) ?? 0) > 0 && (
          <aside
            data-testid="quick-check-card"
            className="flex items-center justify-between gap-4 rounded-2xl border border-line bg-paper-hi p-4"
          >
            <span className="flex items-center gap-2 text-sm">
              <Sparkles className="size-4 text-neb-ink" aria-hidden />
              {plural(dueCounts.get(node.id) ?? 0, "check")} due from what you saved here.
            </span>
            <button
              type="button"
              onClick={actions.onQuickCheck}
              className="shrink-0 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper"
            >
              Quick check
            </button>
          </aside>
        )}

        <div role="tablist" aria-label="Show" className="flex gap-1 border-b border-line">
          <TabButton selected={shown === "pages"} onSelect={() => setTab("pages")}>
            Pages
          </TabButton>
          {hasStudy && (
            <TabButton selected={shown === "study"} onSelect={() => setTab("study")}>
              Study
            </TabButton>
          )}
          {hasMoments && (
            <TabButton selected={shown === "moments"} onSelect={() => setTab("moments")}>
              Moments{moments.length > 0 && ` (${moments.length})`}
            </TabButton>
          )}
        </div>

        {shown === "study" && courseId ? (
          <div role="tabpanel" aria-label="Study">
            <CourseStudy
              id={courseId}
              inNotebook
              onQuiz={actions.onQuiz}
              onRemoved={() => actions.onLinkCourse(null)}
            />
          </div>
        ) : shown === "moments" ? (
          <div role="tabpanel" aria-label="Moments" className="flex flex-col gap-6">
            {unsorted && (
              <FileThese
                moments={moments}
                isLive={(id) => tree.isLive(id)}
                onFile={unsorted.onFile}
                onChoose={unsorted.onChoose}
              />
            )}
            <MomentsList
              moments={moments}
              now={now}
              onOpen={actions.onOpenMoment}
              {...(actions.inNeb && { inNeb: actions.inNeb })}
              {...(actions.onOpenInNeb && { onOpenInNeb: actions.onOpenInNeb })}
              placeOf={(moment) =>
                moment.nodeId === node.id
                  ? null
                  : tree
                      .path(moment.nodeId)
                      .slice(tree.path(node.id).length)
                      .map((n) => n.title)
                      .join(" › ") || null
              }
            />
          </div>
        ) : (
          <div role="tabpanel" aria-label="Pages" className="flex flex-col gap-8">
            {isRoot && !courseId && !unsorted && (
              <AddMaterial tree={tree} onAdd={actions.onImportPdf} onLink={actions.onLinkCourse} />
            )}
            <section aria-labelledby="chapters-heading" className="flex flex-col gap-3">
              <h2 id="chapters-heading" className="text-xs tracking-wide text-muted uppercase">
                {root.childLabel}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {children.map((child, index) => {
                  const done = progressOf(child.id);
                  return (
                    <li key={child.id}>
                      <button
                        type="button"
                        onClick={() => actions.onOpen(child.id)}
                        data-testid="chapter-card"
                        className="flex h-full w-full flex-col gap-2 rounded-2xl border border-line bg-paper-hi p-4 text-left shadow-[0_8px_24px_-18px_rgba(0,0,0,0.35)] transition-colors hover:border-ink/25 motion-reduce:transition-none"
                      >
                        <span className="flex items-center justify-between gap-2 text-xs text-muted tabular-nums">
                          {index + 1}
                          {(dueCounts.get(child.id) ?? 0) > 0 && (
                            <span
                              data-testid="checks-due-badge"
                              className="rounded-full bg-neb/15 px-2 py-0.5 font-medium text-ink"
                            >
                              {plural(dueCounts.get(child.id) ?? 0, "check")} due
                            </span>
                          )}
                        </span>
                        <span className="font-serif text-xl leading-tight">{child.title}</span>
                        {done && (
                          <span data-testid="chapter-progress" className="flex flex-col gap-1">
                            <span className="text-xs text-muted tabular-nums">
                              {done.checked} of {plural(done.total, "topic")} checked
                            </span>
                            <span
                              className="h-1.5 overflow-hidden rounded-full bg-line"
                              aria-hidden
                            >
                              <span
                                className="block h-full rounded-full bg-ink"
                                style={{ width: `${(100 * done.checked) / done.total}%` }}
                              />
                            </span>
                          </span>
                        )}
                        <span className="mt-auto text-xs text-muted">
                          {plural(pageCounts.get(child.id) ?? 0, "page")}
                          {tree.children(child.id).length > 0 &&
                            ` · ${plural(tree.children(child.id).length, "section")}`}{" "}
                          · edited {ago(child.updatedAt, now)}
                        </span>
                      </button>
                    </li>
                  );
                })}
                {canAdd && (
                  <li>
                    <button
                      type="button"
                      onClick={actions.onAddChild}
                      title={keys.shown("new_chapter")}
                      data-keytip={keys.shown("new_chapter")}
                      aria-keyshortcuts={keys.aria("new_chapter")}
                      className="flex h-full min-h-28 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-line p-4 text-sm text-muted hover:border-ink/30 hover:text-ink"
                    >
                      <Plus className="size-4" aria-hidden />
                      Add {noun}
                    </button>
                  </li>
                )}
              </ul>
            </section>

            <section aria-labelledby="pages-heading" className="flex flex-col gap-3">
              <h2 id="pages-heading" className="text-xs tracking-wide text-muted uppercase">
                Loose pages
              </h2>
              <ul className="flex flex-wrap gap-3">
                {pages.map((page) => (
                  <li key={page.id}>
                    <button
                      type="button"
                      onClick={() => actions.onOpenPage(page.id)}
                      className="flex h-28 w-24 flex-col items-center justify-center gap-2 rounded-xl border border-line bg-paper-hi text-sm text-muted hover:border-ink/25 hover:text-ink"
                    >
                      <FileText className="size-5" aria-hidden />
                      Page {page.index + 1}
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    onClick={actions.onAddPage}
                    title={keys.shown("new_page")}
                    data-keytip={keys.shown("new_page")}
                    aria-keyshortcuts={keys.aria("new_page")}
                    className="flex h-28 w-24 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-muted hover:border-ink/30 hover:text-ink"
                  >
                    <Plus className="size-5" aria-hidden />
                    New page
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={actions.onImportPdf}
                    title={keys.shown("import_pdf")}
                    data-keytip={keys.shown("import_pdf")}
                    aria-keyshortcuts={keys.aria("import_pdf")}
                    className="flex h-28 w-24 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line text-sm text-muted hover:border-ink/30 hover:text-ink"
                  >
                    <FileUp className="size-5" aria-hidden />
                    Import PDF
                  </button>
                </li>
              </ul>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * U26: a notebook without course material says once what adding it unlocks. A course the student
 * already has (made before courses lived in notebooks) can be linked instead.
 */
function AddMaterial({
  tree,
  onAdd,
  onLink,
}: {
  tree: NotebookTree<Notebook>;
  onAdd(): void;
  onLink(courseId: string): void;
}) {
  const [courses, setCourses] = useState<{ id: string; title: string }[]>([]);
  const linked = tree
    .children(null)
    .map((n) => n.courseId)
    .filter(Boolean)
    .join(",");
  useEffect(() => {
    let live = true;
    const taken = new Set(linked.split(","));
    void coursesApi
      .list()
      .then((all) => live && setCourses(all.filter((c) => !taken.has(c.id))))
      .catch(() => undefined); // offline: only the PDF button
    return () => {
      live = false;
    };
  }, [linked]);
  return (
    <aside
      data-testid="add-material"
      className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-dashed border-line p-5"
    >
      <span className="flex min-w-0 flex-[1_1_320px] items-start gap-3">
        <GraduationCap className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
        <span className="text-sm">
          <span className="font-medium">Have the syllabus or slides?</span>{" "}
          <span className="text-muted">
            Add them and neb builds lessons, a study plan and quizzes for this notebook.
          </span>
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-3">
        {courses.length > 0 && (
          <label className="text-sm text-muted">
            <span className="sr-only">Use a course you already have</span>
            <select
              data-testid="link-course"
              value=""
              onChange={(event) => event.target.value && onLink(event.target.value)}
              className="rounded-full border border-line bg-paper px-3 py-2"
            >
              <option value="">Use a course you have…</option>
              {courses.map((course) => (
                <option key={course.id} value={course.id}>
                  {course.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          onClick={onAdd}
          className="inline-flex items-center gap-2 rounded-full bg-ink px-4 py-2 text-sm font-medium text-paper"
        >
          <FileUp className="size-4" aria-hidden />
          Add course material
        </button>
      </span>
    </aside>
  );
}

function TabButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted hover:text-ink aria-selected:border-ink aria-selected:text-ink"
    >
      {children}
    </button>
  );
}

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** "just now", "5 minutes ago", "yesterday"… */
export function ago(then: number, now: number): string {
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 60) return "just now";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["minute", 60],
    ["hour", 60],
    ["day", 24],
    ["week", 7],
    ["month", 4.35],
    ["year", 12],
  ];
  let value = seconds / 60;
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  for (const [name, size] of units.slice(1)) {
    if (Math.abs(value) < size) break;
    value /= size;
    unit = name;
  }
  return RELATIVE.format(Math.round(value), unit);
}
