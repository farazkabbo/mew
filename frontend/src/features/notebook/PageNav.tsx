"use client";

import type { Page } from "@mew/shared";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";

type Props = {
  pages: readonly Page[];
  currentPageId: string;
  onSelect(pageId: string): void;
  onAdd(): void;
};

export function PageNav({ pages, currentPageId, onSelect, onAdd }: Props) {
  const index = pages.findIndex((p) => p.id === currentPageId);
  const previous = pages[index - 1];
  const next = pages[index + 1];
  const button =
    "grid size-8 place-items-center rounded-lg text-muted hover:bg-line/50 hover:text-ink disabled:pointer-events-none disabled:opacity-35";

  return (
    <nav
      aria-label="Pages"
      className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-line bg-paper-hi/95 p-1.5 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)] backdrop-blur"
    >
      <button
        className={button}
        aria-label="Previous page"
        disabled={!previous}
        onClick={() => previous && onSelect(previous.id)}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span className="min-w-20 text-center text-xs tabular-nums text-muted" aria-live="polite">
        Page {index + 1} of {pages.length}
      </span>
      <button
        className={button}
        aria-label="Next page"
        disabled={!next}
        onClick={() => next && onSelect(next.id)}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
      <span aria-hidden className="mx-1 h-5 w-px bg-line" />
      <button className={button} aria-label="New page" title="New page" onClick={onAdd}>
        <Plus className="size-4" aria-hidden />
      </button>
    </nav>
  );
}
