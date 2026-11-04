"use client";

import { FolderInput, type LucideIcon } from "lucide-react";
import type { DragEvent, ReactNode } from "react";

import { Keys } from "@/components/ui/Keycap";

/**
 * The Pages tab's pieces (docs/NEB_APP_UI.md decision U28, design/u/notebook-home/Pages): chapter
 * cards with the cover colour along their top, loose pages as small ruled sheets, the dashed add
 * tiles, and the card offering course material.
 */

/** The drag type of a loose page on its way into a chapter. */
export const PAGE_DRAG = "application/x-neb-page";

export function ChapterCard({
  number,
  title,
  cover,
  due,
  progress,
  meta,
  dropping,
  onOpen,
  onDropPage,
  onDragOver,
  onDragLeave,
}: {
  number: number;
  title: string;
  /** The notebook's cover colour, along the card's top edge. */
  cover: string;
  /** Checks due from moments saved in it. */
  due: number;
  progress: { checked: number; total: number } | null;
  meta: string;
  /** A loose page is over it: the drop state. */
  dropping: boolean;
  onOpen(): void;
  onDropPage(pageId: string): void;
  onDragOver(): void;
  onDragLeave(): void;
}) {
  const over = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(PAGE_DRAG)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    onDragOver();
  };
  return (
    <button
      type="button"
      onClick={onOpen}
      onDragOver={over}
      onDragLeave={onDragLeave}
      onDrop={(event) => {
        const pageId = event.dataTransfer.getData(PAGE_DRAG);
        onDragLeave();
        if (!pageId) return;
        event.preventDefault();
        onDropPage(pageId);
      }}
      data-testid="chapter-card"
      data-drop={dropping || undefined}
      className="relative box-border flex min-h-[168px] w-full flex-col gap-3.5 rounded-xl border-t-[6px] bg-paper-hi px-5 pt-5 pb-[18px] text-left text-ink shadow-sh-2 transition-shadow duration-[120ms] hover:shadow-sh-3 data-drop:shadow-sh-3 data-drop:outline-2 data-drop:outline-offset-4 data-drop:outline-ink data-drop:outline-dashed"
      style={{ borderTopColor: cover }}
    >
      <span className="flex items-center gap-3">
        <span className="grid size-[34px] flex-none place-items-center rounded-full border border-line font-serif text-xl leading-none tabular-nums">
          {number}
        </span>
        <span data-testid="chapter-title" className="font-serif text-[26px] leading-[1.1]">
          {title}
        </span>
      </span>
      {due > 0 && (
        <span
          data-testid="checks-due-badge"
          className="inline-flex h-[26px] items-center gap-1.5 self-start rounded-full bg-neb-wash px-2.5 text-[13px] font-semibold text-neb-ink"
        >
          <span aria-hidden className="size-[7px] rounded-full bg-neb" />
          {due === 1 ? "1 check due" : `${due} checks due`}
        </span>
      )}
      {progress && (
        <span data-testid="chapter-progress" className="flex flex-col gap-1.5">
          <span className="text-[13px] tabular-nums">
            {progress.checked} of {progress.total} {progress.total === 1 ? "topic" : "topics"}{" "}
            checked
          </span>
          <span aria-hidden className="h-1 overflow-hidden rounded-full bg-line">
            <span
              className="block h-full rounded-full bg-ink"
              style={{ width: `${(100 * progress.checked) / progress.total}%` }}
            />
          </span>
        </span>
      )}
      <span className="mt-auto text-[13px] text-muted">{meta}</span>
      {dropping && (
        <span className="absolute -bottom-[18px] left-5 inline-flex h-8 items-center rounded-full bg-ink px-3.5 text-[13px] font-semibold text-paper shadow-sh-2">
          Drop to move the page here
        </span>
      )}
    </button>
  );
}

/** The ruled-paper look of a page: a red margin and blue rules. */
const RULED =
  "bg-paper-hi [background-image:linear-gradient(to_right,transparent_15px,var(--margin-red)_15px,var(--margin-red)_16px,transparent_16px),repeating-linear-gradient(to_bottom,transparent_0,transparent_13px,var(--rule)_13px,var(--rule)_14px)] [background-position:0_0,0_18px]";

/** A loose page: a small ruled sheet with a move button. While dragged, its slot shows dashed. */
export function PageTile({
  id,
  label,
  dragging,
  onOpen,
  onMove,
  onDragStart,
  onDragEnd,
}: {
  id: string;
  label: string;
  dragging: boolean;
  onOpen(): void;
  onMove(): void;
  onDragStart(): void;
  onDragEnd(): void;
}) {
  return (
    <div className="flex flex-col gap-1.5" data-testid="loose-page">
      {dragging ? (
        <div
          aria-hidden
          className="box-border h-[124px] rounded-[5px] border-[1.5px] border-dashed border-line"
        />
      ) : (
        <div className="relative">
          <button
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(PAGE_DRAG, id);
              event.dataTransfer.effectAllowed = "move";
              onDragStart();
            }}
            onDragEnd={onDragEnd}
            onClick={onOpen}
            aria-label={`Open ${label}`}
            className={`block h-[124px] w-full rounded-[5px] border border-line shadow-sh-1 transition-transform duration-[120ms] hover:-translate-y-0.5 ${RULED}`}
          />
          <button
            type="button"
            onClick={onMove}
            aria-label={`Move ${label.toLowerCase()} to…`}
            title="Move to…"
            className="absolute top-1.5 right-1.5 grid size-[30px] place-items-center rounded-full border border-line bg-paper text-muted hover:text-ink"
          >
            <FolderInput className="size-[15px]" strokeWidth={1.8} aria-hidden />
          </button>
        </div>
      )}
      <span className={`text-center text-[13px] ${dragging ? "text-muted" : ""}`}>{label}</span>
    </div>
  );
}

/** A dashed tile: Add chapter, New page, Import PDF, with its keys. */
export function AddTile({
  icon: Icon,
  label,
  keys,
  onClick,
  tall = false,
  ariaKeys,
}: {
  icon: LucideIcon;
  label: string;
  keys: string;
  onClick(): void;
  /** A chapter-card-sized tile, not a page-sized one. */
  tall?: boolean;
  ariaKeys?: string | undefined;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={keys}
      data-keytip={keys}
      aria-keyshortcuts={ariaKeys}
      className={`flex w-full flex-col items-center justify-center gap-2 border-[1.5px] border-dashed border-line bg-transparent font-medium text-ink transition-colors duration-[120ms] hover:border-ink/40 ${tall ? "min-h-[168px] rounded-xl text-[15px]" : "h-[124px] rounded-md text-sm"}`}
    >
      <span className="inline-flex items-center gap-2">
        <Icon className={tall ? "size-[18px]" : "size-5"} strokeWidth={1.8} aria-hidden />
        {tall && label}
      </span>
      {!tall && label}
      {keys && <Keys keys={keys.split("+")} size="sm" />}
    </button>
  );
}

/**
 * U26: a notebook without course material says what adding it unlocks; a course the student
 * already has can be linked instead.
 */
export function CourseMaterialCard({
  courses,
  onAdd,
  onLink,
}: {
  courses: readonly { id: string; title: string }[];
  onAdd(): void;
  onLink(courseId: string): void;
}) {
  return (
    <section
      aria-label="Add course material"
      data-testid="add-material"
      className="flex flex-wrap items-center gap-7 rounded-[14px] border border-line bg-paper-hi p-7"
    >
      <span aria-hidden className="relative h-24 w-[120px] flex-none">
        <span className="absolute top-3.5 left-1.5 h-[66px] w-[92px] -rotate-[7deg] rounded-md bg-sunk" />
        <span className="absolute top-2.5 left-4 h-[66px] w-[92px] rotate-3 rounded-md border border-line bg-paper" />
        <span className="absolute top-[18px] left-[22px] box-border flex h-[66px] w-[92px] flex-col gap-1.5 rounded-md border border-line bg-paper-hi p-3 shadow-sh-2">
          <span className="h-1.5 w-[50px] rounded-sm bg-ink" />
          <span className="h-1 w-16 rounded-sm bg-line" />
          <span className="h-1 w-14 rounded-sm bg-line" />
          <span className="h-1 w-10 rounded-sm bg-line" />
        </span>
      </span>
      <div className="min-w-0 flex-[1_1_320px]">
        <h2 className="font-serif text-[28px] leading-[1.1]">Have the syllabus or slides?</h2>
        <p className="mt-2 max-w-[520px] text-[15px] text-muted">
          Add them and neb builds lessons, a study plan and quizzes for this notebook.
        </p>
        <div className="mt-[18px] flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={onAdd}
            className="h-11 rounded-full bg-ink px-[22px] text-[15px] font-semibold text-paper transition-opacity duration-[120ms] hover:opacity-90"
          >
            Add course material
          </button>
          {courses.length > 0 && (
            <SelectPill label="Use a course you already have">
              <select
                data-testid="link-course"
                value=""
                onChange={(event) => event.target.value && onLink(event.target.value)}
                className="h-11 cursor-pointer appearance-none rounded-full border border-ink bg-transparent pr-10 pl-[18px] text-[15px] font-medium text-ink"
              >
                <option value="">Use a course you have…</option>
                {courses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.title}
                  </option>
                ))}
              </select>
            </SelectPill>
          )}
        </div>
      </div>
    </section>
  );
}

function SelectPill({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="relative inline-flex">
      <span className="sr-only">{label}</span>
      {children}
      <svg
        aria-hidden
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="pointer-events-none absolute top-3.5 right-4"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </label>
  );
}
