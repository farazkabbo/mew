"use client";

import type { Notebook, NotebookTree, Page } from "@mew/shared";
import { FileText, Search, Sparkles } from "lucide-react";
import { useId, useMemo, useState } from "react";

import type { Moment } from "../../moments/moments";
import { Dialog } from "./Dialog";
import { fuzzyScore } from "./fuzzy";
import { NodeIcon } from "./node-style";
import { nodeNoun } from "./tree-labels";

const MAX_RESULTS = 12;

type Item =
  | { kind: "node"; id: string; label: string; detail: string; node: Notebook }
  | { kind: "page"; id: string; label: string; detail: string; nodeId: string }
  | { kind: "moment"; id: string; label: string; detail: string; moment: Moment };

type Props = {
  open: boolean;
  tree: NotebookTree<Notebook>;
  /** Every page of a live node. */
  pages: readonly Page[];
  onOpenNode(id: string): void;
  onOpenPage(page: Page): void;
  /** K8: saved moments, found by their question and where they came from. */
  moments?: readonly Moment[];
  onOpenMoment?(moment: Moment): void;
  onClose(): void;
};

/**
 * Ctrl+K: jump to any notebook, chapter, section or page by typing part of its name, or (K8) to
 * a saved moment by its question or source.
 */
export function JumpPalette(props: Props) {
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      label="Jump to"
      className="fixed top-[12vh] mx-auto w-[min(36rem,calc(100vw-2rem))]"
    >
      <PaletteBody {...props} />
    </Dialog>
  );
}

function PaletteBody({
  tree,
  pages,
  moments = [],
  onOpenNode,
  onOpenPage,
  onOpenMoment,
  onClose,
}: Props) {
  const ids = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo(() => {
    const all: Item[] = [];
    const walk = (parentId: string | null) => {
      for (const node of tree.children(parentId)) {
        const path = tree.path(node.id).map((n) => n.title);
        all.push({
          kind: "node",
          id: node.id,
          label: path.join(" › "),
          detail: nodeNoun(tree, node.id),
          node: tree.path(node.id)[0] ?? node,
        });
        walk(node.id);
      }
    };
    walk(null);
    for (const page of pages) {
      if (!tree.isLive(page.notebookId)) continue;
      const path = tree.path(page.notebookId).map((n) => n.title);
      all.push({
        kind: "page",
        id: page.id,
        label: [...path, `Page ${page.index + 1}`].join(" › "),
        detail: "page",
        nodeId: page.notebookId,
      });
    }
    for (const moment of query.trim() ? moments : []) {
      if (!tree.isLive(moment.nodeId)) continue;
      all.push({
        kind: "moment",
        id: moment.imageId,
        label: `${moment.question} · ${moment.sourceName}`,
        detail: "moment",
        moment,
      });
    }
    return all
      .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item);
  }, [tree, pages, moments, query]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "node") onOpenNode(item.id);
    else if (item.kind === "moment") onOpenMoment?.(item.moment);
    else {
      const page = pages.find((p) => p.id === item.id);
      if (page) onOpenPage(page);
    }
  };

  const current = Math.min(active, Math.max(0, items.length - 1));

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 border-b border-rule px-4">
        <Search className="size-4 shrink-0 text-ink-muted" aria-hidden />
        <input
          autoFocus
          value={query}
          role="combobox"
          aria-expanded
          aria-controls={`${ids}-list`}
          aria-activedescendant={items[current] ? `${ids}-${items[current].id}` : undefined}
          aria-label="Jump to a notebook, chapter, page or moment"
          placeholder="Jump to a notebook, chapter, page or moment…"
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + items.length) % Math.max(items.length, 1));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(items[current]);
            }
          }}
          className="w-full bg-transparent py-3.5 text-base outline-none"
        />
      </div>
      <ul id={`${ids}-list`} role="listbox" className="max-h-[50vh] overflow-y-auto p-2">
        {items.map((item, index) => (
          <li
            key={`${item.kind}-${item.id}`}
            id={`${ids}-${item.id}`}
            role="option"
            aria-selected={index === current}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(item)}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-sm aria-selected:bg-rule/60"
          >
            {item.kind === "node" ? (
              <NodeIcon node={item.node} />
            ) : item.kind === "moment" ? (
              <Sparkles className="size-4 shrink-0 text-tutor" aria-hidden />
            ) : (
              <FileText className="size-4 shrink-0 text-ink-muted" aria-hidden />
            )}
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            <span className="text-xs text-ink-muted">{item.detail}</span>
          </li>
        ))}
        {items.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-ink-muted">Nothing matches.</li>
        )}
      </ul>
    </div>
  );
}
