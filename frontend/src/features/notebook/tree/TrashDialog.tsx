"use client";

import { type Notebook, type NotebookTree, TREE_LIMITS } from "@mew/shared";
import { useState } from "react";

import { Dialog } from "./Dialog";
import { ago } from "./NodeHome";
import { NodeIcon } from "./node-style";

type Props = {
  open: boolean;
  tree: NotebookTree<Notebook>;
  now: number;
  onRestore(id: string): void;
  onDeleteForever(id: string): void;
  onClose(): void;
};

/**
 * The trash (K1, docs/NOTEBOOKS_K.md §2.3): what was deleted, with what's inside it, to restore
 * or to delete for good. Everything here goes by itself after 30 days.
 */
export function TrashDialog({ open, tree, now, onRestore, onDeleteForever, onClose }: Props) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const items = tree.trash();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      label="Trash"
      className="fixed top-[12vh] mx-auto w-[min(32rem,calc(100vw-2rem))]"
    >
      <div className="flex flex-col gap-3 p-5">
        <div>
          <h2 className="font-serif text-2xl">Trash</h2>
          <p className="text-sm text-muted">
            Things here are deleted for good after {TREE_LIMITS.trashDays} days.
          </p>
        </div>
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {items.map((node) => {
            const root = tree.path(node.id)[0] ?? node;
            const inside = tree.descendants(node.id).length;
            return (
              <li
                key={node.id}
                className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-line/40"
              >
                <NodeIcon node={root} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{node.title}</span>
                  <span className="block text-xs text-muted">
                    Deleted {ago(node.deletedAt ?? now, now)}
                    {inside > 0 && ` · ${inside} inside`}
                    {node.parentId !== null &&
                      ` · from ${tree
                        .path(node.id)
                        .slice(0, -1)
                        .map((n) => n.title)
                        .join(" › ")}`}
                  </span>
                </span>
                {confirming === node.id ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setConfirming(null);
                        onDeleteForever(node.id);
                      }}
                      className="rounded-lg bg-danger px-3 py-1.5 text-sm text-white"
                    >
                      Delete for good
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="rounded-lg px-2 py-1.5 text-sm text-muted hover:bg-line/60"
                    >
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => onRestore(node.id)}
                      className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-line/50"
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(node.id)}
                      aria-label={`Delete ${node.title} for good`}
                      className="rounded-lg px-2 py-1.5 text-sm text-danger hover:bg-line/60"
                    >
                      Delete
                    </button>
                  </>
                )}
              </li>
            );
          })}
          {items.length === 0 && (
            <li className="py-6 text-center text-sm text-muted">The trash is empty.</li>
          )}
        </ul>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-line/50"
          >
            Close
          </button>
        </div>
      </div>
    </Dialog>
  );
}
