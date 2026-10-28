"use client";

import type { Notebook } from "@mew/shared";
import { ChevronRight, Ellipsis, Plus } from "lucide-react";
import { type KeyboardEvent, type ReactNode, type Ref, useEffect, useRef, useState } from "react";

import { NodeIcon } from "./node-style";

export type DropZone = "before" | "inside" | "after";

export type RowMenuItem = { label: string; shortcut?: string; run(): void; danger?: boolean };

type Props = {
  node: Notebook;
  /** The notebook this row belongs to (for its icon and colour). */
  root: Notebook;
  level: number;
  hasChildren: boolean;
  expanded: boolean;
  current: boolean;
  focused: boolean;
  renaming: boolean;
  /** "chapter", "section"…: what the + button adds; null when nothing can go under it. */
  addNoun: string | null;
  dropZone: DropZone | null;
  menu: readonly RowMenuItem[];
  /** A number shown after the title (K8: the moments waiting in Unsorted). */
  count?: number;
  rowRef: Ref<HTMLDivElement>;
  onOpen(): void;
  onToggle(): void;
  onFocus(): void;
  onAddChild(): void;
  onStartRename(): void;
  /** Saves a new title; resolves to an error to show, or null when it's done. */
  onRename(title: string): Promise<string | null>;
  onCancelRename(): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onDragStart(): void;
  onDragOver(zone: DropZone | null): void;
  onDrop(): void;
};

/** One node in the sidebar tree: open it, expand it, rename it inline, or use its menu. */
export function TreeRow({
  node,
  root,
  level,
  hasChildren,
  expanded,
  current,
  focused,
  renaming,
  addNoun,
  dropZone,
  menu,
  count,
  rowRef,
  onOpen,
  onToggle,
  onFocus,
  onAddChild,
  onStartRename,
  onRename,
  onCancelRename,
  onKeyDown,
  onDragStart,
  onDragOver,
  onDrop,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-label={node.title}
      aria-level={level + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      aria-selected={current}
      aria-current={current ? "page" : undefined}
      tabIndex={focused ? 0 : -1}
      data-testid="tree-row"
      data-node-id={node.id}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onClick={() => !renaming && onOpen()}
      onDoubleClick={(event) => {
        event.preventDefault();
        onStartRename();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      draggable={!renaming}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-neb-node", node.id);
        onDragStart();
      }}
      onDragOver={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientY - box.top) / box.height;
        const zone: DropZone = ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
        onDragOver(zone);
        event.preventDefault();
      }}
      onDragLeave={() => onDragOver(null)}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      className={`group relative flex cursor-pointer items-center gap-1 rounded-lg py-1 pr-1 text-sm outline-none select-none focus-visible:ring-2 focus-visible:ring-ink ${
        current ? "bg-white/10 text-ink" : "text-ink/75 hover:bg-white/5 hover:text-ink"
      } ${dropZone === "inside" ? "ring-2 ring-ink" : ""}`}
      style={{ paddingLeft: `${0.25 + level * 0.9}rem` }}
    >
      {dropZone === "before" && <DropLine at="top" />}
      {dropZone === "after" && <DropLine at="bottom" />}

      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        onClick={(event) => {
          event.stopPropagation();
          onToggle();
        }}
        className={`grid size-5 shrink-0 place-items-center rounded text-ink/50 hover:text-ink ${
          hasChildren ? "" : "invisible"
        }`}
      >
        <ChevronRight
          className={`size-3.5 transition-transform motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
        />
      </button>

      {level === 0 ? (
        <NodeIcon node={root} />
      ) : (
        <span aria-hidden className="mx-1.5 size-1.5 shrink-0 rounded-full bg-ink/35" />
      )}

      {renaming ? (
        <RenameField initial={node.title} onSave={onRename} onCancel={onCancelRename} />
      ) : (
        <span className="min-w-0 flex-1 truncate">{node.title}</span>
      )}
      {!renaming && count !== undefined && count > 0 && (
        <span
          data-testid="tree-row-count"
          aria-label={`${count} waiting`}
          className="shrink-0 rounded-full bg-ink/10 px-1.5 text-xs tabular-nums"
        >
          {count}
        </span>
      )}

      {!renaming && (
        <span className="flex shrink-0 items-center opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          {addNoun && (
            <IconButton
              label={`New ${addNoun} in ${node.title}`}
              onClick={onAddChild}
              icon={<Plus className="size-3.5" />}
            />
          )}
          <IconButton
            label={`More for ${node.title}`}
            onClick={() => setMenuOpen((open) => !open)}
            icon={<Ellipsis className="size-3.5" />}
            expanded={menuOpen}
          />
        </span>
      )}

      {menuOpen && <RowMenu items={menu} onClose={() => setMenuOpen(false)} />}
    </div>
  );
}

function DropLine({ at }: { at: "top" | "bottom" }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute inset-x-1 h-0.5 rounded bg-ink ${
        at === "top" ? "-top-px" : "-bottom-px"
      }`}
    />
  );
}

function IconButton(props: {
  label: string;
  icon: ReactNode;
  onClick(): void;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={props.label}
      title={props.label}
      aria-haspopup={props.expanded !== undefined ? "menu" : undefined}
      aria-expanded={props.expanded}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className="grid size-6 place-items-center rounded-md text-ink/60 hover:bg-white/10 hover:text-ink"
    >
      {props.icon}
    </button>
  );
}

/** The title being edited in place: Enter saves, Esc cancels, leaving the field saves. */
function RenameField(props: {
  initial: string;
  onSave(title: string): Promise<string | null>;
  onCancel(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const save = async () => {
    if (done.current) return;
    const value = input.current?.value ?? "";
    if (value.trim() === props.initial) {
      done.current = true;
      props.onCancel();
      return;
    }
    const problem = await props.onSave(value);
    if (problem) {
      setError(problem);
      input.current?.focus();
    } else {
      done.current = true;
    }
  };

  return (
    <span className="relative min-w-0 flex-1">
      <input
        ref={input}
        defaultValue={props.initial}
        maxLength={80}
        aria-label="Name"
        aria-invalid={error !== null}
        aria-describedby={error ? "rename-error" : undefined}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation(); // the tree's keys don't apply while typing
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          } else if (event.key === "Escape") {
            event.preventDefault();
            done.current = true;
            props.onCancel();
          }
        }}
        onBlur={() => void save()}
        className="w-full rounded-md bg-white/10 px-1.5 py-0.5 text-sm text-ink outline-none focus:ring-2 focus:ring-ink"
      />
      {error && (
        <span
          id="rename-error"
          role="alert"
          className="absolute top-full left-0 z-20 mt-1 w-56 rounded-md bg-ink px-2 py-1 text-xs text-paper shadow-sh-2"
        >
          {error}
        </span>
      )}
    </span>
  );
}

/** The row's actions. Arrow keys move between them; Esc or a click elsewhere closes it. */
function RowMenu({ items, onClose }: { items: readonly RowMenuItem[]; onClose(): void }) {
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const away = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose]);

  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = (at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      ref={menu}
      role="menu"
      onKeyDown={step}
      onClick={(event) => event.stopPropagation()}
      className="absolute top-full right-0 z-30 mt-1 w-52 rounded-xl border border-white/10 bg-paper p-1 text-ink shadow-xl"
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            item.run();
          }}
          className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-sm hover:bg-white/10 focus:bg-white/10 focus:outline-none ${
            item.danger ? "text-danger" : ""
          }`}
        >
          {item.label}
          {item.shortcut && <kbd className="text-xs text-ink/45">{item.shortcut}</kbd>}
        </button>
      ))}
    </div>
  );
}
