"use client";

import {
  Eraser,
  Highlighter,
  History,
  ImageDown,
  LassoSelect,
  type LucideIcon,
  Maximize,
  Pen,
  Redo2,
  Rows3,
  Sparkles,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { useShortcutKeys } from "../shortcuts/useShortcutKeys";
import { HIGHLIGHTER_COLORS, INK_COLORS, PEN_WIDTHS, type PenSize, type Tool } from "./palette";
import { useNotebookUi } from "./store";

type Props = {
  onUndo(): void;
  onRedo(): void;
  onZoom(factor: number): void;
  onResetView(): void;
  onExportLine(): void;
  /** K9: the live annotations' control (level, hide until done, the page's marks). */
  marks?: ReactNode;
  /** K9: "watch how this page was solved" (pressed while it plays). */
  onReplayPage?(): void;
  replayingPage?: boolean;
};

const TOOLS: { tool: Tool; label: string; icon: LucideIcon }[] = [
  { tool: "pen", label: "Pen", icon: Pen },
  { tool: "highlighter", label: "Highlighter", icon: Highlighter },
  { tool: "eraser", label: "Eraser", icon: Eraser },
  { tool: "lasso", label: "Lasso select", icon: LassoSelect },
];

export function Toolbar({
  onUndo,
  onRedo,
  onZoom,
  onResetView,
  onExportLine,
  marks,
  onReplayPage,
  replayingPage = false,
}: Props) {
  const {
    tool,
    inkColor,
    highlighterColor,
    penSize,
    showLines,
    showTutorInk,
    zoom,
    canUndo,
    canRedo,
  } = useNotebookUi();
  const { setTool, setColor, setPenSize, toggleLines, toggleTutorInk } = useNotebookUi.getState();
  const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : INK_COLORS;
  const activeColor = tool === "highlighter" ? highlighterColor : inkColor;
  const keys = useShortcutKeys();

  return (
    <div
      role="toolbar"
      aria-label="Drawing tools"
      className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-rule bg-paper-raised/95 p-1.5 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)] backdrop-blur"
    >
      {TOOLS.map(({ tool: t, label, icon }) => (
        <IconButton
          key={t}
          icon={icon}
          label={`${label} (${keys.shown(t)})`}
          pressed={tool === t}
          onClick={() => setTool(t)}
        />
      ))}

      <Divider />

      <div role="radiogroup" aria-label="Colour" className="flex items-center gap-1 px-1">
        {colors.map((c) => (
          <button
            key={c.name}
            role="radio"
            aria-checked={activeColor === c.light}
            aria-label={c.name}
            title={c.name}
            disabled={tool === "eraser" || tool === "lasso"}
            onClick={() => setColor(c.light)}
            className="grid size-7 place-items-center rounded-full disabled:opacity-40 aria-checked:ring-2 aria-checked:ring-accent"
          >
            {/* Swatches show the colour as it renders in the current theme. */}
            <span
              className="size-4 rounded-full bg-(--swatch-light) dark:bg-(--swatch-dark)"
              style={{ "--swatch-light": c.light, "--swatch-dark": c.dark } as CSSProperties}
            />
          </button>
        ))}
      </div>

      {tool === "pen" && (
        <>
          <Divider />
          <div role="radiogroup" aria-label="Pen size" className="flex items-center gap-0.5">
            {(Object.keys(PEN_WIDTHS) as PenSize[]).map((size) => (
              <button
                key={size}
                role="radio"
                aria-checked={penSize === size}
                aria-label={`Size ${size}`}
                onClick={() => setPenSize(size)}
                className="grid size-8 place-items-center rounded-lg text-ink-muted hover:bg-rule/50 aria-checked:bg-rule aria-checked:text-ink"
              >
                <span
                  className="rounded-full bg-current"
                  style={{ width: PEN_WIDTHS[size] * 1.6, height: PEN_WIDTHS[size] * 1.6 }}
                />
              </button>
            ))}
          </div>
        </>
      )}

      <Divider />
      <IconButton
        icon={Undo2}
        label={`Undo (${keys.shown("undo")})`}
        disabled={!canUndo}
        onClick={onUndo}
      />
      <IconButton
        icon={Redo2}
        label={`Redo (${keys.shown("redo")})`}
        disabled={!canRedo}
        onClick={onRedo}
      />

      <Divider />
      <IconButton icon={ZoomOut} label="Zoom out (−)" onClick={() => onZoom(1 / 1.25)} />
      <button
        onClick={onResetView}
        title="Reset view (0)"
        aria-label={`Zoom ${Math.round(zoom * 100)}%, reset view`}
        className="h-8 min-w-12 rounded-lg px-1 text-xs tabular-nums text-ink-muted hover:bg-rule/50"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton icon={ZoomIn} label="Zoom in (+)" onClick={() => onZoom(1.25)} />
      <IconButton icon={Maximize} label="Reset view (0)" onClick={onResetView} />

      <Divider />
      <IconButton
        icon={Rows3}
        label="Show detected lines"
        pressed={showLines}
        onClick={toggleLines}
      />
      <IconButton
        icon={Sparkles}
        label="Show tutor ink (T)"
        pressed={showTutorInk}
        onClick={toggleTutorInk}
      />
      <IconButton icon={ImageDown} label="Export current line as PNG" onClick={onExportLine} />
      {onReplayPage && (
        <IconButton
          icon={History}
          label={replayingPage ? "Stop the replay" : "Replay this page (how it was solved)"}
          pressed={replayingPage}
          onClick={onReplayPage}
        />
      )}
      {marks}
    </div>
  );
}

function IconButton({
  icon: Icon,
  label,
  pressed,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-ink-muted transition-colors hover:bg-rule/50 hover:text-ink disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-ink aria-pressed:text-paper"
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}

function Divider(): ReactNode {
  return <span aria-hidden className="mx-1 h-5 w-px bg-rule" />;
}
