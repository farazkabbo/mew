"use client";

import type { Notebook, NotebookTree } from "@mew/shared";
import { CornerLeftUp, Search } from "lucide-react";
import { useId, useMemo, useState } from "react";

import { Dialog } from "./Dialog";
import { fuzzyScore } from "./fuzzy";
import { NodeIcon } from "./node-style";

/** A place in the tree: a node, or the top level (null). */
export type Destination = string | null;

type Props = {
  open: boolean;
  title: string;
  tree: NotebookTree<Notebook>;
  /** Why a place can't be picked (shown beside it), or null when it can. */
  refuse(destination: Destination): string | null;
  /** Offer "Top level" as a place (moving a chapter out to be a notebook). */
  topLevel: boolean;
  onPick(destination: Destination): void;
  onClose(): void;
};

/**
 * Picks a place in the notebook tree (K1 "Move to…"; K3's save destinations use it too): a
 * searchable list of every notebook, chapter and section, indented, with the places the rules
 * don't allow shown but disabled, and why.
 */
export function DestinationPicker(props: Props) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      label={props.title}
      className="fixed top-[12vh] mx-auto w-[min(30rem,calc(100vw-2rem))]"
    >
      <PickerBody {...props} />
    </Dialog>
  );
}

type Option = { id: Destination; label: string; path: string; level: number; root?: Notebook };

function PickerBody({ title, tree, refuse, topLevel, onPick, onClose }: Props) {
  const ids = useId();
  const [query, setQuery] = useState("");

  const options = useMemo(() => {
    const all: Option[] = topLevel ? [{ id: null, label: "Top level", path: "", level: 0 }] : [];
    const walk = (parentId: string | null, level: number) => {
      for (const node of tree.children(parentId)) {
        const path = tree.path(node.id);
        all.push({
          id: node.id,
          label: node.title,
          path: path.map((n) => n.title).join(" › "),
          level,
          ...(path[0] && { root: path[0] }),
        });
        walk(node.id, level + 1);
      }
    };
    walk(null, topLevel ? 1 : 0);
    if (!query.trim()) return all;
    return all.filter((o) => o.id !== null && fuzzyScore(query, o.path) > 0);
  }, [tree, topLevel, query]);

  return (
    <div className="flex flex-col">
      <h2 id={`${ids}-title`} className="px-5 pt-4 font-serif text-xl">
        {title}
      </h2>
      <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-line px-3">
        <Search className="size-4 shrink-0 text-muted" aria-hidden />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search notebooks"
          placeholder="Search notebooks"
          className="w-full bg-transparent py-2 text-sm outline-none"
        />
      </div>
      <ul aria-labelledby={`${ids}-title`} className="max-h-[50vh] overflow-y-auto p-2">
        {options.map((option) => {
          const reason = refuse(option.id);
          return (
            <li key={option.id ?? "top"}>
              <button
                type="button"
                disabled={reason !== null}
                onClick={() => {
                  onClose();
                  onPick(option.id);
                }}
                title={reason ?? option.path}
                className="flex w-full items-center gap-2 rounded-lg py-2 pr-3 text-left text-sm hover:bg-line/60 disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent"
                style={{ paddingLeft: `${0.75 + (query ? 0 : option.level) * 1}rem` }}
              >
                {option.id === null ? (
                  <CornerLeftUp className="size-4 shrink-0 text-muted" aria-hidden />
                ) : option.level === 0 || query ? (
                  option.root && <NodeIcon node={option.root} />
                ) : (
                  <span aria-hidden className="mx-1 size-1.5 shrink-0 rounded-full bg-ink/30" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {query ? option.path : option.label}
                </span>
                {reason && <span className="shrink-0 text-xs text-muted">{reason}</span>}
              </button>
            </li>
          );
        })}
        {options.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</li>
        )}
      </ul>
    </div>
  );
}
