"use client";

import {
  ImageDown,
  type LucideIcon,
  Maximize,
  Rows3,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { ReactNode } from "react";

import { useNotebookUi } from "../notebook/store";

/**
 * The page's quiet tools, beside the replay bar (U2): the page's place in its chapter, zoom, the
 * detected lines, neb's ink on or off, export the current line, and the marks menu.
 */
export function PageTools({
  onZoom,
  onResetView,
  onExportLine,
  marks,
  pageNav,
}: {
  onZoom(factor: number): void;
  onResetView(): void;
  onExportLine(): void;
  /** The marks menu (Off, hide until done, this page's marks layer). */
  marks: ReactNode;
  /** Previous and next page. */
  pageNav: ReactNode;
}) {
  const { showLines, showTutorInk, zoom } = useNotebookUi();
  const { toggleLines, toggleTutorInk } = useNotebookUi.getState();
  return (
    <div className="flex shrink-0 items-center gap-0.5 text-muted" aria-label="View" role="group">
      {pageNav}
      <Quiet icon={ZoomOut} label="Zoom out (−)" onClick={() => onZoom(1 / 1.25)} />
      <button
        type="button"
        onClick={onResetView}
        title="Reset view (0)"
        aria-label={`Zoom ${Math.round(zoom * 100)}%, reset view`}
        className="h-8 min-w-11 rounded-full px-1 text-xs tabular-nums hover:bg-ink/5 hover:text-ink"
      >
        {Math.round(zoom * 100)}%
      </button>
      <Quiet icon={ZoomIn} label="Zoom in (+)" onClick={() => onZoom(1.25)} />
      <Quiet icon={Maximize} label="Reset view (0)" onClick={onResetView} />
      <Quiet icon={Rows3} label="Show detected lines" pressed={showLines} onClick={toggleLines} />
      <Quiet
        icon={Sparkles}
        label="Show tutor ink (T)"
        pressed={showTutorInk}
        onClick={toggleTutorInk}
      />
      <Quiet icon={ImageDown} label="Export current line as PNG" onClick={onExportLine} />
      {marks}
    </div>
  );
}

function Quiet({
  icon: Icon,
  label,
  pressed,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className="grid size-8 place-items-center rounded-full hover:bg-ink/5 hover:text-ink aria-pressed:bg-ink aria-pressed:text-paper"
    >
      <Icon className="size-4" strokeWidth={1.8} aria-hidden />
    </button>
  );
}
