"use client";

import {
  Eraser,
  Highlighter,
  ImageDown,
  type LucideIcon,
  Maximize,
  Pen,
  Redo2,
  Rows3,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { HIGHLIGHTER_COLORS, INK_COLORS, PEN_WIDTHS, type PenSize, type Tool } from "./palette";
import { useNotebookUi } from "./store";

type Props = {
  onUndo(): void;
  onRedo(): void;
  onZoom(factor: number): void;
  onResetView(): void;
  onExportLine(): void;
};

const TOOLS: { tool: Tool; label: string; shortcut: string; icon: LucideIcon }[] = [
  { tool: "pen", label: "Pen", shortcut: "P", icon: Pen },
  { tool: "highlighter", label: "Highlighter", shortcut: "H", icon: Highlighter },
  { tool: "eraser", label: "Eraser", shortcut: "E", icon: Eraser },
];

export function Toolbar({ onUndo, onRedo, onZoom, onResetView, onExportLine }: Props) {
  const { tool, inkColor, highlighterColor, penSize, showLines, zoom, canUndo, canRedo } =
    useNotebookUi();
  const { setTool, setColor, setPenSize, toggleLines } = useNotebookUi.getState();
  const colors = tool === "highlighter" ? HIGHLIGHTER_COLORS : INK_COLORS;
  const activeColor = tool === "highlighter" ? highlighterColor : inkColor;

  return (
    <div
      role="toolbar"
      aria-label="Drawing tools"
      className="pointer-events-auto flex items-center gap-1 rounded-2xl border border-rule bg-paper-raised/95 p-1.5 shadow-[0_8px_30px_-12px_rgba(0,0,0,0.25)] backdrop-blur"
    >
      {TOOLS.map(({ tool: t, label, shortcut, icon }) => (
        <IconButton
          key={t}
          icon={icon}
          label={`${label} (${shortcut})`}
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
            disabled={tool === "eraser"}
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
      <IconButton icon={Undo2} label="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} />
      <IconButton icon={Redo2} label="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo} />

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
      <IconButton icon={ImageDown} label="Export current line as PNG" onClick={onExportLine} />
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
