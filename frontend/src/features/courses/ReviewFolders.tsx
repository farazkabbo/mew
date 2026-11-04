"use client";

import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { quizHref } from "./api";
import {
  countRows,
  type FolderCourse,
  type FolderRow,
  folderSummary,
  PULL_MS,
  shortTitle,
  tabSlots,
} from "./review-folders";

/** The tabs' band above each folder's body. */
const TAB_BAND = 50;

/**
 * The Review page's courses as file folders (docs/NEB_APP_UI.md decision U25, board 7). Each
 * course is a folder in its cover colour with its tab in a fixed slot; picking a tab pulls that
 * folder up out of the stack and drops it in front (just a swap with reduced motion).
 */
export function ReviewFolders({ courses }: { courses: readonly FolderCourse[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [prev, setPrev] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const activeId = courses.some((c) => c.id === picked) ? picked : (courses[0]?.id ?? null);
  const { tabs, more } = tabSlots(courses, activeId);
  const slots = tabs.length + (more.length > 0 ? 1 : 0);

  const pick = (id: string) => {
    setMoreOpen(false);
    if (id === activeId) return;
    window.clearTimeout(timer.current);
    setPrev(activeId);
    setPicked(id);
    timer.current = window.setTimeout(() => setPrev(null), PULL_MS);
  };

  // The tabs pattern: arrows move between tabs (and pick), Home and End go to the ends.
  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((c) => c.id === activeId);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % tabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? tabs.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    const id = tabs[next]?.id;
    if (!id) return;
    pick(id);
    tabRefs.current.get(id)?.focus();
  };

  const slot = (i: number) => ({
    left: `calc((100% - 16px) * ${i} / ${slots})`,
    width: `calc((100% - 16px) / ${slots} - 4px)`,
  });

  return (
    <div className="relative isolate" data-testid="review-folders">
      <div role="tablist" aria-label="Courses" onKeyDown={onTabKey}>
        {tabs.map((course, i) => {
          const open = course.id === activeId;
          const isPrev = !open && course.id === prev;
          const pulling = open && prev !== null;
          const tint = `color-mix(in srgb, ${course.color} 42%, var(--paper))`;
          return (
            <div
              key={course.id}
              className={`pointer-events-none *:pointer-events-auto ${open ? "folder-front" : "folder-back"} ${pulling ? "folder-pull-out" : ""}`}
              style={
                open
                  ? { position: "relative", zIndex: 20, paddingTop: TAB_BAND }
                  : {
                      position: "absolute",
                      inset: 0,
                      zIndex: isPrev ? 10 : 1 + i,
                      paddingTop: TAB_BAND,
                      display: "flex",
                      flexDirection: "column",
                    }
              }
            >
              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(course.id, el);
                  else tabRefs.current.delete(course.id);
                }}
                type="button"
                role="tab"
                id={`folder-tab-${course.id}`}
                aria-selected={open}
                aria-controls={`folder-${course.id}`}
                tabIndex={open ? 0 : -1}
                onClick={() => pick(course.id)}
                title={course.title}
                className={`folder-tab absolute top-0 flex h-[51px] items-center gap-2 rounded-t-[10px] pr-3 pb-px pl-3.5 text-sm text-ink ${open ? "font-semibold" : "font-medium shadow-[inset_0_-10px_12px_-10px_rgba(30,29,26,.28)]"}`}
                style={{ ...slot(i), background: tint }}
              >
                <span
                  aria-hidden
                  className="size-2 flex-none rounded-full shadow-[0_0_0_1.5px_rgba(30,29,26,.35)]"
                  style={{ background: course.color }}
                />
                <span className="min-w-0 flex-1 truncate text-left">
                  {shortTitle(course.title)}
                </span>
                {course.quiz > 0 && (
                  <span
                    aria-label={`${course.quiz} to practise`}
                    className="inline-flex h-5 min-w-5 flex-none items-center justify-center rounded-full bg-ink px-1.5 text-xs font-semibold text-paper"
                  >
                    {course.quiz}
                  </span>
                )}
              </button>
              <section
                role="tabpanel"
                id={`folder-${course.id}`}
                aria-labelledby={`folder-tab-${course.id}`}
                aria-hidden={!open}
                inert={!open}
                data-testid="review-course"
                className={`box-border p-7 pb-8 shadow-sh-3 ${i === 0 ? "rounded-[0_14px_14px_14px]" : "rounded-[14px]"} ${open ? "min-h-[380px]" : "flex-1"}`}
                style={{ background: tint }}
              >
                {(open || isPrev) && <FolderBody course={course} />}
              </section>
            </div>
          );
        })}
      </div>
      {more.length > 0 && (
        <MoreTab
          style={slot(tabs.length)}
          courses={more}
          open={moreOpen}
          onToggle={() => setMoreOpen((o) => !o)}
          onClose={() => setMoreOpen(false)}
          onPick={pick}
        />
      )}
    </div>
  );
}

function FolderBody({ course }: { course: FolderCourse }) {
  const counts = countRows(course.rows);
  return (
    <>
      <div className="mb-[22px] flex flex-wrap items-start gap-x-6 gap-y-4">
        <div className="min-w-0 flex-[1_1_260px]">
          <h3 className="font-serif text-[34px] leading-[1.05]">
            <Link href={`/courses/${course.id}`} className="hover:text-ink">
              {course.title}
            </Link>
          </h3>
          <div
            className="mt-3.5 flex h-2 max-w-80 gap-0.5"
            role="img"
            aria-label={folderSummary(course.rows)}
          >
            {counts.revisit > 0 && (
              <span className="rounded-full bg-ink" style={{ flex: counts.revisit }} />
            )}
            {counts.new > 0 && (
              <span
                className="box-border rounded-full border-[1.5px] border-dashed border-muted"
                style={{ flex: counts.new }}
              />
            )}
            {counts.hint + counts.checked > 0 && (
              <span
                className="rounded-full bg-neb"
                style={{ flex: counts.hint + counts.checked }}
              />
            )}
          </div>
          <div className="mt-2 text-[13px] text-ink/80">{folderSummary(course.rows)}</div>
        </div>
        {course.quiz > 0 && (
          <Link
            href={quizHref({ id: course.id, title: course.title })}
            className="inline-flex h-11 flex-none items-center gap-2.5 rounded-full bg-ink pr-4 pl-[22px] text-[15px] font-semibold text-paper transition-opacity duration-[120ms] hover:opacity-90"
          >
            Quiz me
            <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-paper px-1.5 text-xs text-ink">
              {course.quiz}
            </span>
          </Link>
        )}
      </div>
      {course.rows.length > 0 ? (
        <div className="overflow-hidden rounded-md bg-paper-hi shadow-sh-2">
          <ul>
            {course.rows.map((row) => (
              <ConceptRow key={row.conceptId} courseId={course.id} row={row} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="rounded-md bg-paper-hi p-5 text-sm text-muted shadow-sh-2">
          Open a lesson in this course and it shows up here.
        </p>
      )}
    </>
  );
}

const CHIPS: Record<FolderRow["kind"], { label: string; className: string }> = {
  revisit: { label: "Revisit", className: "bg-note py-1 text-ink" },
  new: { label: "New", className: "border border-line py-[3px] text-muted" },
  hint: { label: "With a hint", className: "border border-line py-[3px] text-muted" },
  checked: { label: "Checked", className: "bg-neb-wash py-1 text-neb-ink" },
};

function ConceptRow({ courseId, row }: { courseId: string; row: FolderRow }) {
  const chip = CHIPS[row.kind];
  return (
    <li className="border-b border-rule last:border-b-0" data-testid="review-item">
      <Link
        href={`/courses/${courseId}/concepts/${row.conceptId}`}
        className="flex min-h-16 items-center gap-4 px-[22px] py-2.5 text-ink no-underline hover:bg-paper"
      >
        <RowMark kind={row.kind} />
        <span className="min-w-0 flex-1">
          <span className="block text-base font-semibold">{row.title}</span>
          <span className="block text-[13px] text-muted">{row.detail}</span>
        </span>
        <span
          className={`flex-none rounded-full px-2.5 text-[13px] font-semibold ${chip.className}`}
        >
          {chip.label}
        </span>
        <ChevronRight className="size-5 flex-none text-muted" strokeWidth={1.8} aria-hidden />
      </Link>
    </li>
  );
}

/** The board's shapes: an ink disc with ↺, a dashed ring, a violet-washed disc with ✓. */
function RowMark({ kind }: { kind: FolderRow["kind"] }) {
  if (kind === "revisit")
    return (
      <span
        aria-hidden
        className="inline-flex size-[30px] flex-none items-center justify-center rounded-full bg-ink text-paper"
      >
        <RotateCcw className="size-[15px]" strokeWidth={2.2} />
      </span>
    );
  if (kind === "new")
    return (
      <span
        aria-hidden
        className="box-border size-[30px] flex-none rounded-full border-[1.5px] border-dashed border-muted"
      />
    );
  return (
    <span
      aria-hidden
      className="inline-flex size-[30px] flex-none items-center justify-center rounded-full bg-neb-wash"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke={kind === "checked" ? "var(--neb)" : "var(--muted)"}
        strokeWidth="2.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 12.5l5 5L20 6.5" />
      </svg>
    </span>
  );
}

function MoreTab({
  style,
  courses,
  open,
  onToggle,
  onClose,
  onPick,
}: {
  style: { left: string; width: string };
  courses: readonly FolderCourse[];
  open: boolean;
  onToggle(): void;
  onClose(): void;
  onPick(id: string): void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: globalThis.KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", escape);
    };
  }, [open, onClose]);
  return (
    <div ref={root} className="absolute top-0 z-30" style={style}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={onToggle}
        className="folder-tab flex h-[51px] w-full items-center gap-2 rounded-t-[10px] bg-paper px-3.5 pb-px text-sm font-medium text-ink shadow-[inset_0_-10px_12px_-10px_rgba(30,29,26,.28)]"
      >
        <span className="min-w-0 flex-1 truncate text-left">More</span>
        <span className="text-xs text-muted">{courses.length}</span>
        <ChevronDown className="size-4 flex-none text-muted" aria-hidden />
      </button>
      {open && (
        <ul className="absolute top-[54px] right-0 min-w-56 overflow-hidden rounded-xl border border-line bg-paper-hi py-1 shadow-sh-3">
          {courses.map((course) => (
            <li key={course.id}>
              <button
                type="button"
                onClick={() => onPick(course.id)}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm hover:bg-paper"
              >
                <span
                  aria-hidden
                  className="size-2 flex-none rounded-full"
                  style={{ background: course.color }}
                />
                <span className="min-w-0 flex-1 truncate">{course.title}</span>
                {course.quiz > 0 && <span className="text-xs text-muted">{course.quiz}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
