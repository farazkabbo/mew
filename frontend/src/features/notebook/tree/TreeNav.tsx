"use client";

import { type Notebook, type NotebookTree, shortcutFor, TREE_LIMITS } from "@mew/shared";
import { Plus, Trash2 } from "lucide-react";
import { type KeyboardEvent, useMemo, useRef, useState } from "react";

import { useShortcutKeys } from "../../shortcuts/useShortcutKeys";
import { NodeIcon } from "./node-style";
import { childNoun } from "./tree-labels";
import { type DropZone, type RowMenuItem, TreeRow } from "./TreeRow";

type Props = {
  tree: NotebookTree<Notebook>;
  currentId: string | null;
  renamingId: string | null;
  /** The notebook being made (as named so far), shown as a row while its popover is open. */
  draft: Pick<Notebook, "title" | "icon" | "color"> | null;
  trashCount: number;
  /** K8: a count after a row's title (the moments waiting in Unsorted). */
  counts?: ReadonlyMap<string, number>;
  /** "Alt+B", "Ctrl+N" in the desktop app, or the student's own. */
  newNotebookShortcut: string;
  onOpen(id: string): void;
  onCreateNotebook(): void;
  onAddChild(parentId: string): void;
  onAddPage(id: string): void;
  onStartRename(id: string | null): void;
  /** Saves a title; resolves to an error to show, or null when it's done. */
  onRename(id: string, title: string): Promise<string | null>;
  onMove(id: string, parentId: string | null, index: number): void;
  onReorder(id: string, step: -1 | 1): void;
  onMoveTo(id: string): void;
  /** K4: download its PDF pages for offline use. */
  onKeepOffline(id: string): void;
  onDelete(id: string): void;
  onOpenTrash(): void;
};

type Row = { node: Notebook; level: number; hasChildren: boolean };

/**
 * The notebook tree in the sidebar (K1, docs/NOTEBOOKS_K.md §2.3), as an ARIA tree:
 * - arrows move between rows (→ opens or steps in, ← closes or steps out), Enter opens one,
 *   F2 renames it, Alt+↑/↓ moves it among its siblings (or the student's own shortcuts, K2);
 * - a row is dragged above, below or into another (where the rules allow it);
 * - each row has + (a chapter or section) and a menu (rename, new page, move, delete).
 */
export function TreeNav(props: Props) {
  const { tree, currentId } = props;
  /** Rows the student opened (true) or closed (false); the rest follow the open node. */
  const [choices, setChoices] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; zone: DropZone } | null>(null);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const keys = useShortcutKeys();

  // A row is expanded when the student opened it, or, unless they closed it, when it's the open
  // node or above it (so the open node and its chapters show when they arrive there).
  const expanded = useMemo(() => {
    const path = new Set(currentId ? tree.path(currentId).map((n) => n.id) : []);
    const open = new Set([...path].filter((id) => choices.get(id) !== false));
    for (const [id, isOpen] of choices) if (isOpen) open.add(id);
    return open;
  }, [choices, currentId, tree]);

  const visible = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);
  const tabStop = visible.some((r) => r.node.id === focusedId)
    ? focusedId
    : (visible.find((r) => r.node.id === currentId) ?? visible[0])?.node.id;

  const focusRow = (id: string | undefined) => {
    if (!id) return;
    setFocusedId(id);
    rows.current.get(id)?.focus();
  };

  const toggle = (id: string, open?: boolean) =>
    setChoices((now) => new Map(now).set(id, open ?? !expanded.has(id)));

  const onRowKey = (row: Row, index: number, event: KeyboardEvent<HTMLDivElement>) => {
    const id = row.node.id;
    const shortcut = shortcutFor(event, keys.platform, keys.own);
    if (shortcut === "move_up" || shortcut === "move_down" || shortcut === "rename") {
      event.preventDefault();
      event.stopPropagation(); // handled here (this row), not by the app's own shortcut
      if (shortcut === "rename") props.onStartRename(id);
      else props.onReorder(id, shortcut === "move_up" ? -1 : 1);
      return;
    }
    const moves: Record<string, () => void> = {
      ArrowDown: () => focusRow(visible[index + 1]?.node.id),
      ArrowUp: () => focusRow(visible[index - 1]?.node.id),
      Home: () => focusRow(visible[0]?.node.id),
      End: () => focusRow(visible.at(-1)?.node.id),
      ArrowRight: () => {
        if (!row.hasChildren) return;
        if (!expanded.has(id)) toggle(id, true);
        else focusRow(visible[index + 1]?.node.id);
      },
      ArrowLeft: () => {
        if (row.hasChildren && expanded.has(id)) toggle(id, false);
        else focusRow(tree.parentOf(id) ?? undefined);
      },
      Enter: () => props.onOpen(id),
    };
    const action = moves[event.key];
    if (action && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      action();
    }
  };

  /** Where a drop on `target` would put the dragged node, if the rules allow it. */
  const placement = (target: Notebook, zone: DropZone) => {
    if (!dragging || dragging === target.id) return null;
    const parentId = zone === "inside" ? target.id : tree.parentOf(target.id);
    const siblings = tree.children(parentId).filter((n) => n.id !== dragging);
    const at = siblings.findIndex((n) => n.id === target.id);
    const index = zone === "inside" ? siblings.length : zone === "before" ? at : at + 1;
    return tree.canMove(dragging, parentId).ok ? { parentId, index } : null;
  };

  const menuFor = (row: Row): RowMenuItem[] => {
    const id = row.node.id;
    const depth = tree.depth(id);
    const items: RowMenuItem[] = [
      { label: "Rename", shortcut: keys.shown("rename"), run: () => props.onStartRename(id) },
    ];
    if (depth < TREE_LIMITS.maxDepth) {
      const noun = childNoun(tree, id);
      items.push({ label: `New ${noun}`, run: () => props.onAddChild(id) });
    }
    items.push(
      { label: "New page", shortcut: keys.shown("new_page"), run: () => props.onAddPage(id) },
      { label: "Move to…", run: () => props.onMoveTo(id) },
      { label: "Make available offline", run: () => props.onKeepOffline(id) },
      { label: "Move up", shortcut: keys.shown("move_up"), run: () => props.onReorder(id, -1) },
      { label: "Move down", shortcut: keys.shown("move_down"), run: () => props.onReorder(id, 1) },
      { label: "Delete", run: () => props.onDelete(id), danger: true },
    );
    return items;
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between px-2 pb-1">
        <h2 id="notebooks-heading" className="text-xs tracking-wide text-sidebar-ink/50 uppercase">
          Notebooks
        </h2>
        <button
          type="button"
          onClick={props.onCreateNotebook}
          aria-label={`New notebook (${props.newNotebookShortcut})`}
          title={`New notebook (${props.newNotebookShortcut})`}
          className="grid size-6 place-items-center rounded-md text-sidebar-ink/60 hover:bg-white/10 hover:text-sidebar-ink"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>

      <div
        role="tree"
        aria-labelledby="notebooks-heading"
        className="flex flex-col gap-0.5"
        onDragEnd={() => {
          setDragging(null);
          setDrop(null);
        }}
      >
        {visible.map((row, index) => {
          const id = row.node.id;
          const depth = tree.depth(id);
          return (
            <TreeRow
              key={id}
              node={row.node}
              root={tree.path(id)[0] ?? row.node}
              level={row.level}
              hasChildren={row.hasChildren}
              expanded={expanded.has(id)}
              current={id === currentId}
              focused={id === tabStop}
              renaming={id === props.renamingId}
              addNoun={depth < TREE_LIMITS.maxDepth ? childNoun(tree, id) : null}
              dropZone={drop?.id === id ? drop.zone : null}
              menu={menuFor(row)}
              count={props.counts?.get(id) ?? 0}
              rowRef={(element) => {
                if (element) rows.current.set(id, element);
                else rows.current.delete(id);
              }}
              onOpen={() => props.onOpen(id)}
              onToggle={() => toggle(id)}
              onFocus={() => setFocusedId(id)}
              onAddChild={() => {
                toggle(id, true);
                props.onAddChild(id);
              }}
              onStartRename={() => props.onStartRename(id)}
              onRename={(title) => props.onRename(id, title)}
              onCancelRename={() => props.onStartRename(null)}
              onKeyDown={(event) => onRowKey(row, index, event)}
              onDragStart={() => setDragging(id)}
              onDragOver={(zone) =>
                setDrop(zone && placement(row.node, zone) ? { id, zone } : null)
              }
              onDrop={() => {
                const place = drop?.id === id ? placement(row.node, drop.zone) : null;
                if (place && dragging) props.onMove(dragging, place.parentId, place.index);
                if (place && drop?.zone === "inside") toggle(id, true);
                setDragging(null);
                setDrop(null);
              }}
            />
          );
        })}
        {props.draft && (
          <div
            aria-hidden
            className="flex items-center gap-1 rounded-lg bg-white/10 py-1 pr-1 pl-1 text-sm text-sidebar-ink/80 italic"
          >
            <span className="size-5" />
            <NodeIcon node={props.draft} />
            <span className="min-w-0 flex-1 truncate">
              {props.draft.title || "Untitled notebook"}
            </span>
          </div>
        )}
        {visible.length === 0 && !props.draft && (
          <p className="px-2 py-1 text-sm text-sidebar-ink/45">No notebooks yet.</p>
        )}
      </div>

      {props.trashCount > 0 && (
        <button
          type="button"
          onClick={props.onOpenTrash}
          className="mt-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-ink/55 hover:bg-white/5 hover:text-sidebar-ink"
        >
          <Trash2 className="size-4 shrink-0 opacity-60" aria-hidden />
          Trash
          <span className="ml-auto text-xs tabular-nums">{props.trashCount}</span>
        </button>
      )}
    </div>
  );
}

/** The rows a reader sees: every live node whose ancestors are all expanded, in order. */
function visibleRows(tree: NotebookTree<Notebook>, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (parentId: string | null, level: number) => {
    for (const node of tree.children(parentId)) {
      const hasChildren = tree.children(node.id).length > 0;
      rows.push({ node, level, hasChildren });
      if (hasChildren && expanded.has(node.id)) walk(node.id, level + 1);
    }
  };
  walk(null, 0);
  return rows;
}
