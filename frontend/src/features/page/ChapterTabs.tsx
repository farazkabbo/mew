"use client";

import type { Notebook, NotebookTree } from "@mew/shared";

/** Tints for the tabs that aren't open (board 2), in turn. */
const TINTS = [
  "color-mix(in srgb, var(--teal) 40%, var(--paper))",
  "var(--note)",
  "color-mix(in srgb, var(--margin-red) 55%, var(--paper))",
  "color-mix(in srgb, var(--line) 70%, var(--paper))",
];
/** NEB_APP_UI §4.5: a label is cut after 14 characters (the full name is the tooltip). */
const MAX_LABEL = 14;

/**
 * The notebook's chapters as tabs on the sheet's right edge (docs/NEB_APP_UI.md §4.5). The open
 * one is paper-coloured and joins the sheet; the last tab adds a chapter. A page dragged from the
 * Contents drawer onto a tab moves it there.
 */
export function ChapterTabs({
  tree,
  rootId,
  openId,
  addKeys,
  onContents,
  onOpen,
  onAdd,
  onDropPage,
}: {
  tree: NotebookTree<Notebook>;
  rootId: string;
  /** The open node (a chapter, a section in it, or the notebook itself). */
  openId: string | null;
  addKeys: string;
  /** Contents (the whole tree, §4.10), under the tabs. */
  onContents?(): void;
  onOpen(id: string): void;
  onAdd(): void;
  onDropPage?(pageId: string, chapterId: string): void;
}) {
  const chapters = tree.children(rootId);
  const openChapter = openId ? tree.path(openId)[1]?.id : undefined;
  return (
    <nav
      aria-label="Chapters"
      data-testid="chapter-tabs"
      className="pointer-events-auto flex max-h-full flex-col gap-1.5 overflow-y-auto py-2 [mask-image:linear-gradient(transparent,black_12px,black_calc(100%-12px),transparent)]"
    >
      {chapters.map((chapter, i) => {
        const active = chapter.id === openChapter;
        const label = `${i + 1} · ${chapter.title}`;
        return (
          <button
            key={chapter.id}
            type="button"
            aria-current={active ? "page" : undefined}
            title={label.length > MAX_LABEL ? label : undefined}
            onClick={() => onOpen(chapter.id)}
            onDragOver={(event) => {
              if (onDropPage && event.dataTransfer.types.includes("application/x-neb-page"))
                event.preventDefault();
            }}
            onDrop={(event) => {
              const pageId = event.dataTransfer.getData("application/x-neb-page");
              if (pageId) onDropPage?.(pageId, chapter.id);
            }}
            className={`h-11 shrink-0 truncate rounded-[0_8px_8px_0] px-3 text-left text-[13px] transition-[width,margin] duration-[220ms] ease-[cubic-bezier(.2,.8,.2,1)] ${
              active
                ? "-ml-1 w-[150px] font-semibold text-ink shadow-[0_1px_0_var(--line)]"
                : "w-32 font-medium text-ink/80 hover:w-[136px]"
            }`}
            style={{ background: active ? "var(--paper)" : TINTS[i % TINTS.length] }}
          >
            {label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}…` : label}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        title={`New chapter (${addKeys}) · or say “add a chapter called optics”`}
        data-keytip={addKeys}
        className="flex h-11 w-32 shrink-0 items-center gap-1.5 rounded-[0_8px_8px_0] bg-[color-mix(in_srgb,var(--line)_45%,var(--desk))] px-3 text-[13px] text-muted hover:text-ink"
      >
        + chapter
        <span className="text-[11px] opacity-70">{addKeys.replace("+", " ")}</span>
      </button>
      {onContents && (
        <button
          type="button"
          onClick={onContents}
          title="Contents: every notebook, chapter and page"
          className="mt-2 h-9 w-32 shrink-0 rounded-[0_8px_8px_0] px-3 text-left text-[13px] text-muted hover:text-ink"
        >
          Contents
        </button>
      )}
    </nav>
  );
}
