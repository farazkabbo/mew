"use client";

import type { Notebook } from "@mew/shared";
import { BookOpen, GraduationCap, Plus, RotateCcw, Sparkles } from "lucide-react";
import Link from "next/link";

type Props = {
  notebooks: readonly Notebook[];
  currentId: string | null;
  onSelect(id: string): void;
  onCreate(): void;
  /** Starts "Quiz me" on the open notebook's course; null when it has no course. */
  onQuiz: (() => void) | null;
};

/** Planned sections, shown disabled until their milestone lands. */
const UPCOMING = ["Library", "Mind map", "Flowchart", "Just practise"];

const LINK =
  "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-sidebar-ink/75 hover:bg-white/5 hover:text-sidebar-ink";

export function Sidebar({ notebooks, currentId, onSelect, onCreate, onQuiz }: Props) {
  return (
    <aside className="hidden w-60 shrink-0 flex-col bg-sidebar text-sidebar-ink md:flex">
      <Link href="/" className="px-5 pt-5 pb-6 font-serif text-2xl tracking-tight">
        mew
      </Link>

      <nav
        aria-label="Notebooks"
        className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3"
      >
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-xs tracking-wide text-sidebar-ink/50 uppercase">Notebooks</h2>
          <button
            onClick={onCreate}
            aria-label="New notebook"
            title="New notebook"
            className="grid size-6 place-items-center rounded-md text-sidebar-ink/60 hover:bg-white/10 hover:text-sidebar-ink"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </div>
        <ul className="flex flex-col gap-0.5">
          {notebooks.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => onSelect(n.id)}
                aria-current={n.id === currentId ? "page" : undefined}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-ink/75 hover:bg-white/5 hover:text-sidebar-ink aria-[current=page]:bg-white/10 aria-[current=page]:text-sidebar-ink"
              >
                <BookOpen className="size-4 shrink-0 opacity-60" aria-hidden />
                <span className="truncate">{n.title}</span>
              </button>
            </li>
          ))}
        </ul>

        <h2 className="mt-6 px-2 pb-1 text-xs tracking-wide text-sidebar-ink/50 uppercase">
          Study
        </h2>
        <Link href="/courses" className={LINK}>
          <GraduationCap className="size-4 shrink-0 opacity-60" aria-hidden />
          Courses
        </Link>
        <Link href="/review" className={LINK}>
          <RotateCcw className="size-4 shrink-0 opacity-60" aria-hidden />
          Review
        </Link>

        <h2 className="mt-6 px-2 pb-1 text-xs tracking-wide text-sidebar-ink/50 uppercase">
          Study modes
        </h2>
        <button
          onClick={onQuiz ?? undefined}
          disabled={!onQuiz}
          title={
            onQuiz ? "Quiz yourself on this course" : "Open a course notebook to quiz yourself"
          }
          className={`${LINK} text-left disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          <Sparkles className="size-4 shrink-0 opacity-60" aria-hidden />
          Quiz me
        </button>

        <h2 className="mt-6 px-2 pb-1 text-xs tracking-wide text-sidebar-ink/50 uppercase">
          Coming soon
        </h2>
        <ul className="flex flex-col gap-0.5">
          {UPCOMING.map((label) => (
            <li key={label} className="rounded-lg px-2 py-1.5 text-sm text-sidebar-ink/35">
              {label}
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  );
}
