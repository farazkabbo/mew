"use client";

import type { Notebook, NotebookTree } from "@mew/shared";
import { ChevronLeft, Menu } from "lucide-react";

import { Keys } from "@/components/ui/Keycap";

import { Breadcrumb } from "../notebook/tree/Breadcrumb";
import { LevelSwitch } from "./LevelSwitch";

/**
 * The page's header (docs/NEB_APP_UI.md §4.1, board 2): back to the desk, the contents, where you
 * are (Physics › Ch 3 · Projectiles › Page 4), how much neb marks, and Fold the margin (Alt C).
 */
export function PageHeader({
  tree,
  nodeId,
  pageNumber,
  rootId,
  folded,
  checkKeys,
  page,
  onDesk,
  onContents,
  onOpenHome,
  onFold,
}: {
  tree: NotebookTree<Notebook>;
  nodeId: string;
  /** The open page's number, or null on a node's home. */
  pageNumber: number | null;
  rootId: string | null;
  folded: boolean;
  checkKeys: string;
  page: boolean;
  onDesk(): void;
  onContents(): void;
  onOpenHome(id: string): void;
  onFold(): void;
}) {
  return (
    <header
      data-testid="page-header"
      className="pointer-events-auto flex h-16 shrink-0 items-center gap-2 px-4"
    >
      <button
        type="button"
        onClick={onDesk}
        aria-label="Back to the desk"
        title="Back to the desk"
        className="grid size-10 place-items-center rounded-full text-ink hover:bg-ink/5"
      >
        <ChevronLeft className="size-5" strokeWidth={2} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onContents}
        aria-label="Contents"
        title="Contents (every notebook, chapter and page)"
        className="grid size-10 place-items-center rounded-full text-muted hover:bg-ink/5 hover:text-ink"
      >
        <Menu className="size-5" strokeWidth={1.8} aria-hidden />
      </button>
      <div className="min-w-0 flex-1 text-[15px]">
        <Breadcrumb
          tree={tree}
          nodeId={nodeId}
          {...(pageNumber !== null && { pageNumber })}
          onOpen={onOpenHome}
        />
      </div>

      {rootId && <LevelSwitch notebookId={rootId} />}
      {page && (
        <button
          type="button"
          onClick={onFold}
          aria-pressed={folded}
          title={`${folded ? "Unfold the margin" : "Fold the margin: marks wait until you're done"} (${checkKeys}) · or say “fold the margin”`}
          data-keytip={checkKeys}
          className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-line bg-paper px-3.5 text-sm text-ink hover:border-ink/40 aria-pressed:border-ink"
        >
          <svg
            viewBox="0 0 24 24"
            className="size-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            aria-hidden
          >
            <path d="M4 4h10l6 6v10H4z" />
            <path d="M14 4v6h6" />
          </svg>
          {folded ? "Unfold" : "Fold the margin"}
          <Keys keys={checkKeys.split("+")} size="sm" />
        </button>
      )}
    </header>
  );
}
