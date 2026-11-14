"use client";

import {
  type ConceptProgress,
  type ConceptStatus,
  type CourseDetail,
  localDate,
  planExam,
  progressFor,
} from "@mew/shared";
import { ChevronRight, NotebookPen, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { coursesApi, formatDue, formatPages, notebookHref, quizHref } from "./api";
import { ExamPlanCard } from "./ExamPlanView";
import { StatusChip } from "./StatusChip";

/** Concepts shown before "Show N more". */
const SHOWN = 8;

/**
 * The confirmed plan (docs/NEB_APP_UI.md decision U28, board Study): the summary in big numbers
 * with a status bar, Quiz me, the concepts in course order (status, when each comes back, what it
 * comes after, its pages; each opens its lesson), and the exam plan beside them.
 */
export function StudyPlan({
  detail,
  onChange,
  inNotebook = false,
  onQuiz,
}: {
  detail: CourseDetail;
  onChange(detail: CourseDetail): void;
  /** Shown as a notebook's Study tab (U26): no button back to the notebook it's in. */
  inNotebook?: boolean;
  /** In the notebook (U26), Quiz me starts the quiz there instead of navigating to it. */
  onQuiz?: () => void;
}) {
  const { course, concepts, edges } = detail;
  const [known, setKnown] = useState<ConceptProgress[] | null>(null);
  const [now] = useState(() => new Date());
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    coursesApi.progress(course.id).then(
      (p) => !cancelled && setKnown(p.concepts),
      () => !cancelled && setKnown([]), // no progress yet is shown as "not started"
    );
    return () => {
      cancelled = true;
    };
  }, [course.id]);

  const ids = useMemo(() => concepts.map((c) => c.id), [concepts]);
  const progress = useMemo(() => progressFor(ids, known ?? []), [ids, known]);
  const plan = useMemo(
    () =>
      course.exam_date
        ? planExam({ orderedIds: ids, progress, examDate: course.exam_date, today: localDate(now) })
        : null,
    [course.exam_date, ids, progress, now],
  );
  const counts: Record<ConceptStatus, number> = {
    checked: 0,
    practised_with_hint: 0,
    revisit: 0,
    explored: 0,
    not_started: 0,
  };
  for (const p of progress.values()) counts[p.status]++;
  const examIn = plan
    ? plan.daysLeft > 0
      ? `in ${plan.daysLeft} day${plan.daysLeft === 1 ? "" : "s"}`
      : plan.daysLeft === 0
        ? "today"
        : "passed"
    : null;
  const summary = [
    `${concepts.length} concepts`,
    `${counts.checked} checked`,
    counts.revisit > 0 ? `${counts.revisit} to revisit` : null,
    examIn ? `exam ${examIn}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shown = all ? concepts : concepts.slice(0, SHOWN);
  const quizClass =
    "inline-flex h-12 items-center rounded-full bg-ink px-[26px] text-[15px] font-semibold text-paper transition-opacity duration-[120ms] hover:opacity-90";

  return (
    <section aria-label="Study plan">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <dl
          role="group"
          aria-label={summary}
          data-testid="plan-summary"
          className="m-0 flex flex-wrap gap-x-10 gap-y-3"
        >
          <Figure label="Concepts" value={concepts.length} />
          <Figure label="Checked" value={counts.checked} />
          {counts.revisit > 0 && <Figure label="To revisit" value={counts.revisit} />}
          {plan && plan.daysLeft >= 0 && (
            <Figure
              label="Exam in"
              value={plan.daysLeft}
              unit={plan.daysLeft === 1 ? "day" : "days"}
            />
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          {onQuiz ? (
            <button type="button" onClick={onQuiz} className={quizClass}>
              Quiz me
            </button>
          ) : (
            <Link href={quizHref(course)} className={quizClass}>
              Quiz me
            </Link>
          )}
          {!inNotebook && (
            <Link
              href={notebookHref(course)}
              className="inline-flex h-12 items-center gap-2 rounded-full border border-ink px-5 text-[15px] font-semibold text-ink"
            >
              <NotebookPen className="size-4" aria-hidden />
              Open the course notebook
            </Link>
          )}
        </div>
      </div>
      {known && <StatusBar counts={counts} />}

      <div className="mt-8 flex flex-wrap items-start gap-8">
        <section aria-labelledby="study-order" className="min-w-0 flex-[999_1_520px]">
          <h2
            id="study-order"
            className="mb-2 text-xs font-semibold tracking-[0.1em] text-muted uppercase"
          >
            In course order
          </h2>
          <ol className="overflow-hidden rounded-xl bg-paper-hi shadow-sh-2">
            {shown.map((concept) => {
              const index = concepts.indexOf(concept);
              const after = edges
                .filter((e) => e.to_concept === concept.id)
                .map((e) => concepts.findIndex((c) => c.id === e.from_concept))
                .filter((i) => i >= 0);
              const state = progress.get(concept.id);
              return (
                <ConceptRow
                  key={concept.id}
                  href={`/courses/${course.id}/concepts/${concept.id}`}
                  number={index + 1}
                  title={concept.title}
                  status={known && state ? state.status : null}
                  when={whenLine(state, now)}
                  after={after.map((i) => ({ number: i + 1, title: concepts[i]?.title ?? "" }))}
                  pages={concept.source_pages.length ? formatPages(concept.source_pages) : ""}
                />
              );
            })}
            {concepts.length > SHOWN && !all && (
              <li>
                <button
                  type="button"
                  onClick={() => setAll(true)}
                  className="h-[52px] w-full text-sm font-medium text-ink hover:bg-paper"
                >
                  Show {concepts.length - SHOWN} more concepts
                </button>
              </li>
            )}
          </ol>
        </section>
        <ExamPlanCard
          detail={detail}
          onChange={onChange}
          plan={plan && plan.daysLeft >= 0 && known ? plan : null}
        />
      </div>
    </section>
  );
}

function Figure({ label, value, unit }: { label: string; value: number; unit?: string }) {
  return (
    <div>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="m-0 mt-0.5 font-serif text-[44px] leading-none tabular-nums">
        {value}
        {unit && <span className="text-2xl"> {unit}</span>}
      </dd>
    </div>
  );
}

/** One bar per status, sized by how many: checked, with a hint, revisit, explored, not started. */
export function StatusBar({ counts }: { counts: Record<ConceptStatus, number> }) {
  const parts: { status: ConceptStatus; className: string }[] = [
    { status: "checked", className: "bg-neb" },
    {
      status: "practised_with_hint",
      className: "bg-neb-wash shadow-[inset_0_0_0_1.5px_var(--neb)]",
    },
    { status: "revisit", className: "bg-ink" },
    { status: "explored", className: "shadow-[inset_0_0_0_1.5px_var(--muted)]" },
    { status: "not_started", className: "bg-line" },
  ];
  const label = [
    `${counts.checked} checked`,
    `${counts.practised_with_hint} with a hint`,
    `${counts.revisit} to revisit`,
    `${counts.explored} explored`,
    `${counts.not_started} not started`,
  ].join(", ");
  return (
    <div role="img" aria-label={label} className="mt-6 flex h-2.5 gap-[3px]">
      {parts
        .filter((p) => counts[p.status] > 0)
        .map((p) => (
          <span
            key={p.status}
            className={`rounded-full ${p.className}`}
            style={{ flex: counts[p.status] }}
          />
        ))}
    </div>
  );
}

function whenLine(state: ConceptProgress | undefined, now: Date): string {
  if (!state) return "Not started";
  const review = state.due && state.attempts > 0 ? `review ${formatDue(state.due, now)}` : null;
  switch (state.status) {
    case "checked":
      return ["Checked on your own", review].filter(Boolean).join(" · ");
    case "practised_with_hint":
      return ["Practised with a hint", review].filter(Boolean).join(" · ");
    case "revisit":
      return ["Time for another look", review].filter(Boolean).join(" · ");
    case "explored":
      return "Lesson opened · not practised yet";
    case "not_started":
      return "Not started";
  }
}

/**
 * A concept in the plan: its status disc, number, title, when it comes back, "after N" (the full
 * name on hover), its pages in a quiet column, and its status chip. It opens the lesson.
 */
export function ConceptRow({
  href,
  number,
  title,
  status,
  when,
  after,
  pages,
}: {
  href: string;
  number: number;
  title: string;
  status: ConceptStatus | null;
  when: string;
  after: readonly { number: number; title: string }[];
  pages: string;
}) {
  return (
    <li data-testid="plan-concept" className="border-b border-line last:border-b-0">
      <div className="flex min-h-[68px] items-center gap-3.5 px-[18px] py-2.5">
        <StatusDisc status={status} />
        <span className="w-5 flex-none text-right text-[13px] text-muted tabular-nums">
          {number}
        </span>
        <span className="min-w-0 flex-1">
          <Link href={href} className="block text-base font-semibold text-ink hover:underline">
            {title}
          </Link>
          <span className="block text-[13px] text-muted">{when}</span>
        </span>
        {after.length > 0 && (
          <span
            title={`Needs: ${after.map((a) => a.title).join(", ")}`}
            data-testid="concept-after"
            className="flex-none rounded-full border border-line px-2 py-0.5 text-xs text-muted"
          >
            after {after.map((a) => a.number).join(", ")}
          </span>
        )}
        <span className="w-16 flex-none text-right text-[13px] text-muted tabular-nums max-sm:hidden">
          {pages}
        </span>
        {status && <StatusChip status={status} />}
        <ChevronRight className="size-[18px] flex-none text-muted" strokeWidth={1.8} aria-hidden />
      </div>
    </li>
  );
}

/** The shapes used on Review too: ink ↺, violet-washed ✓, a muted ✓ for a hint, rings. */
function StatusDisc({ status }: { status: ConceptStatus | null }) {
  const base = "inline-flex size-8 flex-none items-center justify-center rounded-full";
  if (status === "revisit")
    return (
      <span aria-hidden className={`${base} bg-ink text-paper`}>
        <RotateCcw className="size-[15px]" strokeWidth={2.2} />
      </span>
    );
  if (status === "checked" || status === "practised_with_hint")
    return (
      <span aria-hidden className={`${base} bg-neb-wash`}>
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke={status === "checked" ? "var(--neb)" : "var(--muted)"}
          strokeWidth={status === "checked" ? 2.8 : 2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 12.5l5 5L20 6.5" />
        </svg>
      </span>
    );
  if (status === "explored")
    return (
      <span
        aria-hidden
        className={`${base} box-border border-[1.5px] border-dashed border-muted`}
      />
    );
  return <span aria-hidden className={`${base} box-border border-[1.5px] border-line`} />;
}
