"use client";

import { type Notebook, Subject } from "@mew/shared";
import { ChevronDown } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef } from "react";

import { NebDot } from "@/components/ui/NebDot";

import { COLORS, ICONS } from "../tree/node-style";

/**
 * The notebook home's header pieces (docs/NEB_APP_UI.md decision U28, design/u/notebook-home):
 * the cover mark, the Subject pill, the one neb notice above the tabs, and the divider tabs.
 */

/** The notebook's icon as a small cover: its colour, a darker binding, a paper label. */
export function CoverMark({ node }: { node: Pick<Notebook, "icon" | "color"> }) {
  const Icon = ICONS[node.icon ?? "book"].icon;
  return (
    <span
      aria-hidden
      data-testid="cover-mark"
      className="flex h-[68px] w-[52px] flex-none items-center justify-center rounded-[3px_9px_9px_3px] shadow-[inset_7px_0_0_rgba(0,0,0,.14),var(--sh-2)]"
      style={{ background: COLORS[node.color ?? "slate"].hex }}
    >
      <span className="ml-1.5 grid size-[30px] place-items-center rounded bg-[#FFFEFB] text-[#1E1D1A]">
        <Icon className="size-4" strokeWidth={2} />
      </span>
    </span>
  );
}

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

/** Subject as a pill select, its chevron inside, right beside the label. */
export function SubjectSelect({
  value,
  onChange,
}: {
  value: Subject | null;
  onChange(subject: Subject | null): void;
}) {
  return (
    <label className="inline-flex items-center gap-2">
      Subject
      <span className="relative inline-flex">
        <select
          data-testid="notebook-subject"
          value={value ?? ""}
          onChange={(event) => {
            const subject = Subject.safeParse(event.target.value);
            onChange(subject.success ? subject.data : null);
          }}
          className="h-[34px] cursor-pointer appearance-none rounded-full border border-line bg-paper pr-[34px] pl-3.5 text-sm font-medium text-ink"
        >
          <option value="">Not set</option>
          {Subject.options.map((subject) => (
            <option key={subject} value={subject}>
              {SUBJECT_LABELS[subject]}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden
          strokeWidth={1.8}
          className="pointer-events-none absolute top-[9px] right-3 size-4 text-muted"
        />
      </span>
    </label>
  );
}

/**
 * The one card above the tabs for what neb has for the student (checks due, a PDF being read,
 * topics found). Its first line is neb's voice; its action is the neb button only when neb starts
 * something, else ink.
 */
export function NebNotice({
  voice,
  text,
  thinking = false,
  action,
  testId,
}: {
  voice: string;
  text: string;
  thinking?: boolean;
  action?: { label: string; neb: boolean; run(): void } | undefined;
  testId?: string;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[14px] bg-neb-wash py-3.5 pr-3.5 pl-4"
    >
      <NebDot state={thinking ? "thinking" : "watching"} size={34} />
      <div className="min-w-0 flex-[1_1_280px]">
        <div className="neb-voice text-[15px]">{voice}</div>
        <div className="text-sm text-ink/80">{text}</div>
      </div>
      {action && (
        <button
          type="button"
          onClick={action.run}
          className={`h-11 shrink-0 rounded-full px-[22px] text-[15px] font-semibold transition-opacity duration-[120ms] hover:opacity-90 ${action.neb ? "bg-neb text-white" : "bg-ink text-paper"}`}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export type DividerTab<T extends string> = { id: T; label: string; count?: number | null };

/**
 * Tabs that join the paper sheet under them, like notebook dividers: the active one is the sheet's
 * paper, the others the darker desk. Arrows, Home and End move between them (and choose).
 */
export function DividerTabs<T extends string>({
  tabs,
  selected,
  onSelect,
  label,
  idPrefix,
  children,
}: {
  tabs: readonly DividerTab<T>[];
  selected: T;
  onSelect(id: T): void;
  label: string;
  idPrefix: string;
  children: ReactNode;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((t) => t.id === selected);
    const last = tabs.length - 1;
    const next =
      event.key === "ArrowRight"
        ? index === last
          ? 0
          : index + 1
        : event.key === "ArrowLeft"
          ? index === 0
            ? last
            : index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : null;
    const tab = next === null ? undefined : tabs[next];
    if (!tab) return;
    event.preventDefault();
    onSelect(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  const first = tabs[0]?.id === selected;
  return (
    <div>
      <div role="tablist" aria-label={label} onKeyDown={onKey} className="flex items-end gap-1.5">
        {tabs.map((tab) => {
          const on = tab.id === selected;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                if (el) refs.current.set(tab.id, el);
                else refs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${tab.id}`}
              aria-selected={on}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={on ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={`inline-flex items-center gap-2 rounded-t-xl text-[15px] ${on ? "h-[52px] bg-paper px-[22px] font-semibold text-ink" : "h-11 bg-sunk px-[18px] font-medium text-muted hover:text-ink"}`}
            >
              {tab.label}
              {tab.count != null && tab.count > 0 && (
                <span className="font-medium tabular-nums opacity-70">{tab.count}</span>
              )}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${idPrefix}-panel`}
        aria-labelledby={`${idPrefix}-tab-${selected}`}
        aria-label={tabs.find((t) => t.id === selected)?.label}
        className={`bg-paper px-8 pt-8 pb-10 shadow-sh-2 max-sm:px-4 ${first ? "rounded-[0_16px_16px_16px]" : "rounded-2xl"}`}
      >
        {children}
      </div>
    </div>
  );
}
