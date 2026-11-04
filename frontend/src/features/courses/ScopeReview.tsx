"use client";

import type { ConceptReview, CourseDetail } from "@mew/shared";
import { ArrowDown, ArrowUp, GitMerge, Loader2, RotateCcw, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { coursesApi, CourseApiError, formatPages } from "./api";

type Row = { id: string; title: string; removed: boolean; mergedInto: string | null };

/**
 * The scope review (brief §8; docs/NEB_APP_UI.md decision U28, board Study "plan"): the proposed
 * concepts in order, with their prerequisites and pages. The student can rename, reorder, remove
 * or merge them, set an exam date, then start. Moving a row keeps the keyboard on its button.
 */
export function ScopeReview({
  detail,
  onSaved,
}: {
  detail: CourseDetail;
  onSaved(detail: CourseDetail): void;
}) {
  const { course, concepts, edges } = detail;
  const [rows, setRows] = useState<Row[]>(() =>
    concepts.map((c) => ({ id: c.id, title: c.title, removed: false, mergedInto: null })),
  );
  const [examDate, setExamDate] = useState(course.exam_date ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map(concepts.map((c) => [c.id, c])), [concepts]);
  // After a move, the moved row's same button keeps the focus (its title when that's disabled).
  const list = useRef<HTMLOListElement>(null);
  const refocus = useRef<{ id: string; action: string } | null>(null);
  useEffect(() => {
    const wanted = refocus.current;
    if (!wanted) return;
    refocus.current = null;
    const row = list.current?.querySelector(`[data-row="${wanted.id}"]`);
    const button = row?.querySelector<HTMLButtonElement>(`[aria-label="${wanted.action}"]`);
    (button && !button.disabled ? button : row?.querySelector("input"))?.focus();
  });
  const titleOf = (id: string) => rows.find((r) => r.id === id)?.title ?? byId.get(id)?.title;
  const active = rows.filter((r) => !r.removed && !r.mergedInto);

  const update = (id: string, patch: Partial<Row>) =>
    setRows((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const move = (index: number, by: -1 | 1) => {
    const row = rows[index];
    if (row) refocus.current = { id: row.id, action: by < 0 ? "Move up" : "Move down" };
    setRows((list) => {
      const next = [...list];
      const target = index + by;
      const [a, b] = [next[index], next[target]];
      if (!a || !b) return list;
      next[index] = b;
      next[target] = a;
      return next;
    });
  };
  /** Merge into the nearest kept concept above. */
  const mergeUp = (index: number) => {
    const row = rows[index];
    const into = rows.slice(0, index).findLast((r) => !r.removed && !r.mergedInto);
    if (row && into) update(row.id, { mergedInto: into.id });
  };

  const start = async () => {
    setSaving(true);
    setError(null);
    const merges = new Map<string, string[]>();
    for (const row of rows) {
      if (row.mergedInto)
        merges.set(row.mergedInto, [...(merges.get(row.mergedInto) ?? []), row.id]);
    }
    const review: ConceptReview = {
      merges: [...merges].map(([into, sources]) => ({ into, sources })),
      order: active.map((r) => r.id),
      titles: Object.fromEntries(
        active.filter((r) => r.title !== byId.get(r.id)?.title).map((r) => [r.id, r.title.trim()]),
      ),
    };
    try {
      await coursesApi.review(course.id, review);
      onSaved(await coursesApi.update(course.id, { status: "ready", exam_date: examDate || null }));
    } catch (e) {
      setError(e instanceof CourseApiError ? e.message : "Couldn't save the review.");
      setSaving(false);
    }
  };

  return (
    <section aria-label="Review the concepts">
      <h2 className="font-serif text-[34px] leading-[1.05]">Review the plan</h2>
      <p className="mt-2 max-w-[640px] text-[15px] text-muted">
        neb proposed {concepts.length} {concepts.length === 1 ? "concept" : "concepts"} from your
        material, in a suggested order. Rename, reorder, merge or remove any of them before you
        start.
      </p>

      <ol ref={list} className="mt-6 overflow-hidden rounded-xl bg-paper-hi shadow-sh-2">
        {rows.map((row, index) => {
          const concept = byId.get(row.id);
          const needs = edges
            .filter((e) => e.to_concept === row.id)
            .map((e) => titleOf(e.from_concept))
            .filter(Boolean);
          const off = row.removed || row.mergedInto;
          return (
            <li
              key={row.id}
              data-testid="review-concept"
              data-row={row.id}
              className="flex flex-wrap items-start gap-x-3 gap-y-2 border-b border-line py-2.5 pr-3.5 pl-[18px] last:border-b-0"
            >
              <span className="w-5 shrink-0 pt-2.5 text-right text-[13px] text-muted tabular-nums">
                {off ? "–" : active.findIndex((r) => r.id === row.id) + 1}
              </span>
              <div className={`min-w-0 flex-[1_1_260px] ${off ? "opacity-45" : ""}`}>
                <input
                  aria-label={`Title of concept ${index + 1}`}
                  value={row.title}
                  disabled={Boolean(off)}
                  maxLength={120}
                  onChange={(e) => update(row.id, { title: e.target.value })}
                  className="h-10 w-full rounded-lg border border-line bg-paper px-3 text-[15px] font-medium text-ink focus:border-ink focus:outline-none"
                />
                <p className="mt-1 px-1 text-[13px] text-muted">
                  {row.mergedInto
                    ? `Merged into “${titleOf(row.mergedInto)}”`
                    : row.removed
                      ? "Removed"
                      : [
                          concept?.summary,
                          needs.length ? `Needs: ${needs.join(", ")}` : null,
                          concept?.source_pages.length ? formatPages(concept.source_pages) : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                </p>
              </div>
              <div className="flex shrink-0 items-start gap-0.5 pt-0.5">
                {off ? (
                  <Action
                    label="Restore"
                    onClick={() => update(row.id, { removed: false, mergedInto: null })}
                  >
                    <RotateCcw />
                  </Action>
                ) : (
                  <>
                    <Action label="Move up" disabled={index === 0} onClick={() => move(index, -1)}>
                      <ArrowUp />
                    </Action>
                    <Action
                      label="Move down"
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </Action>
                    <Action
                      label="Merge into the one above"
                      disabled={index === 0}
                      onClick={() => mergeUp(index)}
                    >
                      <GitMerge />
                    </Action>
                    <Action label="Remove" onClick={() => update(row.id, { removed: true })}>
                      <X />
                    </Action>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="mt-7 flex flex-wrap items-end gap-4 border-t border-line pt-6">
        <label className="flex flex-col gap-1.5 text-[13px] text-muted">
          Exam date (optional)
          <input
            type="date"
            value={examDate}
            onChange={(e) => setExamDate(e.target.value)}
            className="h-11 rounded-[10px] border border-line bg-paper-hi px-3 text-sm font-medium text-ink outline-none focus:border-ink"
          />
        </label>
        <span className="flex-1" />
        <button
          onClick={() => void start()}
          disabled={saving || active.length === 0}
          className="inline-flex h-12 items-center gap-2 rounded-full bg-ink px-[26px] text-[15px] font-semibold text-paper transition-opacity duration-[120ms] hover:opacity-90 disabled:opacity-40"
        >
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
          Start studying ({active.length} concept{active.length === 1 ? "" : "s"})
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-muted">
          {error}
        </p>
      )}
    </section>
  );
}

function Action({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick(): void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-lg text-ink hover:bg-ink/5 disabled:opacity-30 [&>svg]:size-4"
    >
      {children}
    </button>
  );
}
