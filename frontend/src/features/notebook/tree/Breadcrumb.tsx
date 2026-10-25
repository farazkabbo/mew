"use client";

import type { Notebook, NotebookTree } from "@mew/shared";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";

type Props = {
  tree: NotebookTree<Notebook>;
  nodeId: string;
  /** The page open in the node, shown last ("Page 3"); none on a home view. */
  pageNumber?: number;
  onOpen(id: string): void;
};

/** Physics › Chapter 5 › Page 3 (K1, docs/NOTEBOOKS_K.md §2.3). Each node opens its home. */
export function Breadcrumb({ tree, nodeId, pageNumber, onOpen }: Props) {
  const path = tree.path(nodeId);
  return (
    <nav aria-label="Breadcrumb" data-testid="breadcrumb">
      <ol className="flex min-w-0 items-center gap-1 text-sm text-ink-muted">
        {path.map((node, i) => {
          const last = i === path.length - 1 && pageNumber === undefined;
          return (
            <Fragment key={node.id}>
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden />}
              <li className="min-w-0">
                <button
                  type="button"
                  onClick={() => onOpen(node.id)}
                  aria-current={last ? "location" : undefined}
                  className="block max-w-48 truncate rounded px-1 hover:bg-rule/50 hover:text-ink aria-[current=location]:text-ink"
                >
                  {node.title}
                </button>
              </li>
            </Fragment>
          );
        })}
        {pageNumber !== undefined && (
          <>
            <ChevronRight className="size-3.5 shrink-0 opacity-60" aria-hidden />
            <li aria-current="page" className="shrink-0 px-1 text-ink">
              Page {pageNumber}
            </li>
          </>
        )}
      </ol>
    </nav>
  );
}
