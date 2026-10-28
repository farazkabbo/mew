"use client";

import type { Notebook, NotebookTree, Page } from "@mew/shared";
import { FileText, Search, Sparkles } from "lucide-react";
import { Fragment, useId, useMemo, useState } from "react";

import { Keys } from "@/components/ui/Keycap";

import { clipImageUrl } from "../../moments/api";
import type { Moment } from "../../moments/moments";
import { Dialog } from "./Dialog";
import { fuzzyMatches, fuzzyScore } from "./fuzzy";
import { NodeIcon } from "./node-style";
import { nodeNoun } from "./tree-labels";

const MAX_RESULTS = 12;

/** NEB_APP_UI §5.8: results come in these groups, in this order. */
const GROUPS = ["Commands", "Notebooks", "Chapters", "Pages", "Moments"] as const;

/** A command typed after "> " (§5.8): what it does, its keys, and what to say instead. */
export type PaletteCommand = { id: string; label: string; keys: string; say: string; run(): void };
type Group = (typeof GROUPS)[number];

type Item =
  | { kind: "command"; id: string; label: string; detail: string; command: PaletteCommand }
  | { kind: "node"; id: string; label: string; detail: string; node: Notebook; root: boolean }
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
  /** "> " lists these (U9). */
  commands?: readonly PaletteCommand[];
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
      className="fixed top-[12vh] mx-auto w-[min(640px,calc(100vw-2rem))] bg-paper-hi shadow-sh-3"
    >
      <PaletteBody {...props} />
    </Dialog>
  );
}

function PaletteBody({
  tree,
  pages,
  moments = [],
  commands = [],
  onOpenNode,
  onOpenPage,
  onOpenMoment,
  onClose,
}: Props) {
  const ids = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const items = useMemo(() => {
    // "> " lists the commands (§5.8), the rest of the query narrowing them.
    if (query.startsWith(">")) {
      const rest = query.slice(1).trim();
      return commands
        .map((command) => ({ command, score: fuzzyScore(rest, `${command.label} ${command.say}`) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ command }): Item => ({
          kind: "command",
          id: command.id,
          label: command.label,
          detail: command.say,
          command,
        }));
    }
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
          root: parentId === null,
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
    const best = all
      .map((item) => ({ item, score: fuzzyScore(query, item.label) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item);
    // Grouped (the best first within each group); the arrows go through them in this order.
    return GROUPS.flatMap((group) => best.filter((item) => groupOf(item) === group));
  }, [tree, pages, moments, commands, query]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    if (item.kind === "command") item.command.run();
    else if (item.kind === "node") onOpenNode(item.id);
    else if (item.kind === "moment") onOpenMoment?.(item.moment);
    else {
      const page = pages.find((p) => p.id === item.id);
      if (page) onOpenPage(page);
    }
  };

  const current = Math.min(active, Math.max(0, items.length - 1));

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-3 border-b border-line px-5">
        <Search className="size-5 shrink-0 text-muted" strokeWidth={1.8} aria-hidden />
        <input
          autoFocus
          value={query}
          role="combobox"
          aria-expanded
          aria-controls={`${ids}-list`}
          aria-activedescendant={items[current] ? `${ids}-${items[current].id}` : undefined}
          aria-label="Jump to a notebook, chapter, page or moment"
          placeholder="Jump to a notebook, chapter, page or moment… (> for commands)"
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
          className="w-full bg-transparent py-4 font-serif text-[22px] outline-none placeholder:text-muted/70"
        />
      </div>
      <ul id={`${ids}-list`} role="listbox" className="max-h-[56vh] overflow-y-auto p-2">
        {items.map((item, index) => {
          const group = groupOf(item);
          const first = index === 0 || groupOf(items[index - 1]!) !== group;
          return (
            <Fragment key={`${item.kind}-${item.id}`}>
              {first && (
                <li
                  role="presentation"
                  className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase"
                >
                  {group}
                </li>
              )}
              <li
                id={`${ids}-${item.id}`}
                role="option"
                aria-selected={index === current}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(item)}
                className="flex cursor-pointer items-center gap-3 rounded-[10px] px-3 py-2 text-[15px] aria-selected:bg-ink/[0.06]"
              >
                {item.kind === "command" ? (
                  <span aria-hidden className="w-4 shrink-0 text-center font-semibold text-muted">
                    ›
                  </span>
                ) : item.kind === "node" ? (
                  <NodeIcon node={item.node} />
                ) : item.kind === "moment" ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a private, signed-in image
                  <img
                    src={clipImageUrl(item.moment.imageId)}
                    alt=""
                    className="h-8 w-12 shrink-0 rounded-[4px] bg-line object-cover"
                  />
                ) : (
                  <FileText className="size-4 shrink-0 text-muted" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate">
                  <Matched
                    text={item.label}
                    query={item.kind === "command" ? query.slice(1) : query}
                  />
                </span>
                {item.kind === "command" ? (
                  <span className="flex shrink-0 items-center gap-3">
                    <span className="neb-voice hidden text-xs sm:inline">{item.detail}</span>
                    {item.command.keys && <Keys keys={item.command.keys.split("+")} size="sm" />}
                  </span>
                ) : item.kind === "moment" ? (
                  <Sparkles className="size-3.5 shrink-0 text-neb-ink" aria-hidden />
                ) : (
                  <span className="text-xs text-muted">{item.detail}</span>
                )}
              </li>
            </Fragment>
          );
        })}
        {items.length === 0 && (
          <li className="px-3 py-6 text-center text-sm text-muted">Nothing matches.</li>
        )}
      </ul>
    </div>
  );
}

function groupOf(item: Item): Group {
  if (item.kind === "command") return "Commands";
  if (item.kind === "node") return item.root ? "Notebooks" : "Chapters";
  return item.kind === "page" ? "Pages" : "Moments";
}

/** The label with the typed characters underlined (ink, never violet: §5.8). */
function Matched({ text, query }: { text: string; query: string }) {
  const hits = new Set(fuzzyMatches(query, text));
  if (hits.size === 0) return <>{text}</>;
  return (
    <>
      {text.split("").map((char, i) =>
        hits.has(i) ? (
          <span key={i} className="underline decoration-ink decoration-2 underline-offset-[3px]">
            {char}
          </span>
        ) : (
          char
        ),
      )}
    </>
  );
}
