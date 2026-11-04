"use client";

import {
  chapterProgress,
  type CourseProgress,
  type Notebook,
  type NotebookTree,
  type Page,
  type Subject,
  TREE_LIMITS,
} from "@mew/shared";
import { FilePlus, FileUp, Plus } from "lucide-react";
import { useEffect, useState } from "react";

import { coursesApi } from "../../courses/api";
import { CourseStudy } from "../../courses/CourseStudy";
import { FileThese } from "../../moments/FileThese";
import { type Moment, subtreeIds } from "../../moments/moments";
import { MomentsList } from "../../moments/MomentsList";
import { useShortcutKeys } from "../../shortcuts/useShortcutKeys";
import {
  CoverMark,
  type DividerTab,
  DividerTabs,
  NebNotice,
  SubjectSelect,
} from "../home/HomeParts";
import { AddTile, ChapterCard, CourseMaterialCard, PageTile } from "../home/PagesParts";
import { COLORS } from "./node-style";
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
  /** Picks where a loose page goes (the destination picker). */
  onMovePage(pageId: string): void;
  /** Puts a page into a chapter (a loose page dropped on its card). */
  onMovePageTo(pageId: string, nodeId: string): void;
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
  /** K8: moments with a check due (their clip ids). */
  dueClipIds?: ReadonlySet<string>;
  onOpenMoment(moment: Moment): void;
  /** Opens a moment and replays its explanation. */
  onReplayMoment?(moment: Moment): void;
  /** Notes Check on a moment. */
  onCheckMoment?(moment: Moment): void;
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

export type HomeTab = "pages" | "study" | "moments";

/** Loose pages shown before "Show all". */
const LOOSE_SHOWN = 14;

/**
 * A notebook's (or chapter's) home (K1, docs/NOTEBOOKS_K.md §2.2; docs/NEB_APP_UI.md decisions
 * U26 and U28, design/u/notebook-home). Its header is the cover, the name, the meta line and
 * Subject (the breadcrumb is the top bar's); one neb notice sits above the tabs.
 *
 * A notebook is the whole class (U26): Pages always, Study once it has course material, Moments
 * once something was saved, as divider tabs joined to the sheet under them. Until it has course
 * material, one card offers to add it.
 */
export function NodeHome({
  node,
  tree,
  loadCounts,
  pages,
  now,
  moments,
  dueCounts,
  dueClipIds,
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
  // A loose page moved into a chapter changes its count: read the counts again when they move.
  const loose = pages.length;
  const [pageCounts, setPageCounts] = useState<ReadonlyMap<string, number>>(new Map());

  useEffect(() => {
    let live = true;
    void loadCounts(childIds ? childIds.split(",") : []).then(
      (counts) => live && setPageCounts(counts),
    );
    return () => {
      live = false;
    };
  }, [childIds, loadCounts, loose]);
  // K4 decision 8: once a PDF's topics are found, a notice says so (the import never waits).
  const [topics, setTopics] = useState<"processing" | "review" | null>(null);
  const [conceptCount, setConceptCount] = useState<number | null>(null);
  const courseId = root.courseId ?? null;
  // The Study tab shows the course's state itself (and polls it): no notice, no second poll.
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
          setConceptCount(detail.concepts.length);
          // Still being read: look again shortly (the notice updates on its own).
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
  // A loose page being dragged (its slot shows dashed), and the chapter card it's over.
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [allPages, setAllPages] = useState(false);
  const isRoot = node.parentId === null;
  const hasStudy = isRoot && courseId !== null;
  const hasMoments = moments.length > 0 || unsorted !== undefined;
  // A tab that went away (the course was removed, the last moment moved) falls back to Pages.
  const shown: HomeTab =
    (tab === "study" && !hasStudy) || (tab === "moments" && !hasMoments) ? "pages" : tab;
  const noun = childNoun(tree, node.id);
  const totalPages = children.reduce((sum, c) => sum + (pageCounts.get(c.id) ?? 0), pages.length);
  const cover = COLORS[root.color ?? "slate"].hex;
  const due = dueCounts.get(node.id) ?? 0;

  const tabs: DividerTab<HomeTab>[] = [
    { id: "pages", label: "Pages", count: totalPages },
    ...(hasStudy ? [{ id: "study" as const, label: "Study", count: conceptCount }] : []),
    ...(hasMoments ? [{ id: "moments" as const, label: "Moments", count: moments.length }] : []),
  ];

  // One notice above the tabs: the PDF being read or its topics found, else checks due.
  const notice =
    courseId && topics && shown !== "study" ? (
      <NebNotice
        testId="review-topics"
        thinking={topics === "processing"}
        voice={
          topics === "review"
            ? "neb found the topics in your pdf."
            : "neb is finding the topics in your pdf…"
        }
        text={
          topics === "review"
            ? "Check them so it can quiz you and track what you know."
            : "You can write on its pages meanwhile. Study fills in when it's done."
        }
        action={
          topics === "review"
            ? { label: "Review topics", neb: false, run: () => setTab("study") }
            : undefined
        }
      />
    ) : due > 0 ? (
      <NebNotice
        testId="quick-check-card"
        voice="from what you saved here"
        text={`${plural(due, "check")} due · about ${Math.max(1, due * 2)} min`}
        action={{ label: "Quick check", neb: true, run: actions.onQuickCheck }}
      />
    ) : null;

  const looseShown = allPages ? pages : pages.slice(0, LOOSE_SHOWN);

  return (
    <div className="h-full overflow-y-auto" data-testid="node-home">
      <div className="mx-auto flex max-w-[1080px] flex-col px-10 pt-10 pb-28 max-sm:px-4">
        <header className="flex flex-wrap items-center gap-5">
          <CoverMark node={root} />
          <div className="min-w-0">
            <h1 className="font-serif text-[56px] leading-none tracking-[-0.01em] max-sm:text-[40px]">
              {node.title}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2.5 text-sm text-muted">
              <span className="tabular-nums">
                {plural(children.length, noun)} · {plural(totalPages, "page")}
              </span>
              {node.parentId === null && !unsorted && (
                <>
                  <span aria-hidden className="size-1 rounded-full bg-line" />
                  <SubjectSelect value={node.subject ?? null} onChange={actions.onSetSubject} />
                </>
              )}
            </div>
          </div>
        </header>

        {notice && <div className="mt-7">{notice}</div>}

        <div className="mt-9">
          <DividerTabs<HomeTab>
            tabs={tabs}
            selected={shown}
            onSelect={setTab}
            label="Notebook"
            idPrefix="home"
          >
            {shown === "study" && courseId ? (
              <CourseStudy
                id={courseId}
                inNotebook
                onQuiz={actions.onQuiz}
                onRemoved={() => actions.onLinkCourse(null)}
              />
            ) : shown === "moments" ? (
              <div className="flex flex-col gap-6">
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
                  {...(actions.onReplayMoment && { onReplay: actions.onReplayMoment })}
                  {...(actions.onCheckMoment && { onCheckNotes: actions.onCheckMoment })}
                  {...(dueClipIds && { dueClipIds })}
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
              <div className="flex flex-col gap-10">
                {isRoot && !courseId && !unsorted && (
                  <AddMaterial
                    tree={tree}
                    onAdd={actions.onImportPdf}
                    onLink={actions.onLinkCourse}
                  />
                )}
                {(children.length > 0 || canAdd) && (
                  <section aria-labelledby="chapters-heading">
                    <div className="mb-4 flex items-baseline gap-3">
                      <h2 id="chapters-heading" className="font-serif text-[28px] leading-none">
                        {root.childLabel}
                      </h2>
                      {children.length > 0 && (
                        <span className="text-sm text-muted tabular-nums">{children.length}</span>
                      )}
                    </div>
                    <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
                      {children.map((child, index) => {
                        const sections = tree.children(child.id).length;
                        return (
                          <li key={child.id}>
                            <ChapterCard
                              number={index + 1}
                              title={child.title}
                              cover={cover}
                              due={dueCounts.get(child.id) ?? 0}
                              progress={progressOf(child.id)}
                              meta={[
                                plural(pageCounts.get(child.id) ?? 0, "page"),
                                sections > 0 ? plural(sections, "section") : null,
                                `edited ${ago(child.updatedAt, now)}`,
                              ]
                                .filter(Boolean)
                                .join(" · ")}
                              dropping={dropTarget === child.id}
                              onOpen={() => actions.onOpen(child.id)}
                              onDragOver={() => setDropTarget(child.id)}
                              onDragLeave={() => setDropTarget((t) => (t === child.id ? null : t))}
                              onDropPage={(pageId) => {
                                setDragging(null);
                                actions.onMovePageTo(pageId, child.id);
                              }}
                            />
                          </li>
                        );
                      })}
                      {canAdd && (
                        <li>
                          <AddTile
                            tall
                            icon={Plus}
                            label={`Add ${noun}`}
                            keys={keys.shown("new_chapter")}
                            ariaKeys={keys.aria("new_chapter")}
                            onClick={actions.onAddChild}
                          />
                        </li>
                      )}
                    </ul>
                  </section>
                )}

                <section aria-labelledby="pages-heading">
                  <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
                    <h2 id="pages-heading" className="font-serif text-[28px] leading-none">
                      Loose pages
                    </h2>
                    {pages.length > 0 && (
                      <span className="text-sm text-muted tabular-nums">{pages.length}</span>
                    )}
                    <span className="flex-1" />
                    {pages.length > 0 && children.length > 0 && (
                      <span className="text-[13px] text-muted">
                        Drag a page onto a {noun} to put it there.
                      </span>
                    )}
                  </div>
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-x-3.5 gap-y-5">
                    <li>
                      <AddTile
                        icon={FilePlus}
                        label="New page"
                        keys={keys.shown("new_page")}
                        ariaKeys={keys.aria("new_page")}
                        onClick={actions.onAddPage}
                      />
                    </li>
                    <li>
                      <AddTile
                        icon={FileUp}
                        label="Import PDF"
                        keys={keys.shown("import_pdf")}
                        ariaKeys={keys.aria("import_pdf")}
                        onClick={actions.onImportPdf}
                      />
                    </li>
                    {looseShown.map((page) => (
                      <li key={page.id}>
                        <PageTile
                          id={page.id}
                          label={`Page ${page.index + 1}`}
                          dragging={dragging === page.id}
                          onOpen={() => actions.onOpenPage(page.id)}
                          onMove={() => actions.onMovePage(page.id)}
                          onDragStart={() => setDragging(page.id)}
                          onDragEnd={() => {
                            setDragging(null);
                            setDropTarget(null);
                          }}
                        />
                      </li>
                    ))}
                    {pages.length > looseShown.length && (
                      <li className="flex flex-col gap-1.5">
                        <button
                          type="button"
                          onClick={() => setAllPages(true)}
                          className="h-[124px] rounded-[5px] border border-line bg-sunk text-[15px] font-semibold text-ink"
                        >
                          +{pages.length - looseShown.length}
                        </button>
                        <span className="text-center text-[13px] text-muted">Show all</span>
                      </li>
                    )}
                  </ul>
                </section>
              </div>
            )}
          </DividerTabs>
        </div>
      </div>
    </div>
  );
}

/** U26: the course-material card, with the courses no notebook has yet. */
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
  return <CourseMaterialCard courses={courses} onAdd={onAdd} onLink={onLink} />;
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
