"use client";

import type { Annotation } from "@mew/shared";
import { type RefObject, useEffect, useState } from "react";

import { NebDot, type NebDotState } from "@/components/ui/NebDot";

import type { LiveAnnotator } from "../annotate/annotator";
import { MarkMenu, markLabel } from "../annotate/MarkLayer";
import { useLiveMarks } from "../annotate/store";
import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import { useNotebookUi } from "../notebook/store";

/** NEB_APP_UI §4.2. */
export const LANE = { minWidth: 150, maxWidth: 200, share: 0.18, folded: 12 } as const;
/** Notes closer than this (screen px) stack: the later one goes below. */
const MIN_GAP = 56;
/** Open notes shown at once (K9's cap); more wait behind "+N more". */
const MAX_NOTES = 6;
const NOTE_KINDS = new Set<Annotation["markKind"]>(["error", "missing", "margin", "unsure"]);

type Camera = { x: number; y: number; zoom: number };

/** Where each note sits: its mark's middle on screen, and the card's top (after stacking). */
export function laneLayout(
  marks: readonly Pick<Annotation, "id" | "hitBox">[],
  camera: Camera,
  height: number,
): { id: string; top: number; markX: number; markY: number }[] {
  const placed = marks
    .filter((m) => m.hitBox)
    .map((m) => {
      const [x, y, , h] = m.hitBox ?? [0, 0, 0, 0];
      return {
        id: m.id,
        // The connector ends at the mark's near edge (its circle), not through the student's ink.
        markX: (x - camera.x) * camera.zoom,
        // …its top corner, so it runs above the line's writing rather than through it.
        markY: (y + h * 0.15 - camera.y) * camera.zoom,
      };
    })
    .sort((a, b) => a.markY - b.markY);
  let last = -Infinity;
  return placed
    .map((p) => {
      const top = Math.max(p.markY - 18, last + MIN_GAP);
      last = top;
      return { ...p, top };
    })
    .filter((p) => p.top < height - 40);
}

/**
 * The neb lane (docs/NEB_APP_UI.md §4.2): the margin of the sheet, where neb's words go. The dot
 * sits at the top; each open mark's note is a card aligned to its line, with a connector to the
 * mark itself (the circle stays on the page, in the marks layer). Notes never overlap: a close
 * one stacks below. Folded (§4.4) the lane is a 12 px strip with the dot as a tab.
 */
export function NebLane({
  canvas,
  live,
  width,
  folded,
  dot,
  onWhy,
  onUnfold,
  onDot,
}: {
  canvas: RefObject<CanvasHandle | null>;
  live: LiveAnnotator;
  width: number;
  folded: boolean;
  dot: NebDotState;
  onWhy(mark: Annotation): void;
  onUnfold(): void;
  onDot(): void;
}) {
  const marks = useLiveMarks((s) => s.marks);
  const pageId = useLiveMarks((s) => s.pageId);
  const hiddenHere = useNotebookUi((s) => (pageId ? s.marksHiddenOn.has(pageId) : false));
  const showTutorInk = useNotebookUi((s) => s.showTutorInk);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, zoom: 1 });
  const [height, setHeight] = useState(800);
  const [overflowOpen, setOverflowOpen] = useState(false);

  useEffect(
    () => canvas.current?.onCamera((c) => setCamera({ x: c.x, y: c.y, zoom: c.zoom })),
    [canvas],
  );
  useEffect(() => {
    const measure = () => setHeight(window.innerHeight);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  const shown = hiddenHere || !showTutorInk ? [] : marks.filter((m) => m.revealed);
  const notes = shown.filter((m) => NOTE_KINDS.has(m.markKind));
  const visible = overflowOpen ? notes : notes.slice(0, MAX_NOTES);
  const layout = laneLayout(visible, camera, height);
  const open = notes.length;

  if (folded) {
    return (
      <button
        type="button"
        onClick={onUnfold}
        aria-label={`Unfold the margin${open ? `: ${open} ${open === 1 ? "note" : "notes"}` : ""}`}
        data-testid="neb-lane"
        data-folded="true"
        className="relative h-full shrink-0 border-r border-margin-red bg-[linear-gradient(90deg,var(--paper),color-mix(in_srgb,var(--ink)_8%,var(--paper)))] shadow-[inset_-3px_0_6px_-3px_#0003]"
        style={{ width: LANE.folded }}
      >
        <span className="absolute top-3 left-0.5 grid size-6 place-items-center rounded-r-md bg-neb text-[11px] font-semibold text-white">
          {open || "·"}
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="neb's margin"
      data-testid="neb-lane"
      className="pointer-events-none relative z-30 h-full shrink-0 border-r border-margin-red"
      style={{ width }}
    >
      <div className="pointer-events-auto absolute top-3 left-3">
        <button type="button" onClick={onDot} aria-label="neb's options" className="rounded-full">
          <NebDot state={open > 0 && dot === "watching" ? "has-note" : dot} notes={open} label />
        </button>
      </div>
      <div aria-live="polite" className="sr-only">
        {notes[0]?.note ? `neb noted a line: ${notes[0].note}` : ""}
      </div>

      {/* Connectors: from each card's right edge to its mark, over the page. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 overflow-visible"
        width="1"
        height="1"
      >
        {layout.map((p) => (
          <g key={p.id}>
            <line
              x1={width - 8}
              y1={p.top + 18}
              x2={p.markX + width}
              y2={p.markY}
              stroke="var(--neb)"
              strokeWidth="2"
            />
            <circle cx={p.markX + width} cy={p.markY} r="2" fill="var(--neb)" />
          </g>
        ))}
      </svg>

      {layout.map((p) => {
        const mark = visible.find((m) => m.id === p.id);
        if (!mark) return null;
        return (
          <NebNote
            key={mark.id}
            mark={mark}
            live={live}
            top={p.top}
            width={width - 16}
            onWhy={onWhy}
          />
        );
      })}

      {notes.length > MAX_NOTES && (
        <button
          type="button"
          onClick={() => setOverflowOpen((v) => !v)}
          className="neb-voice pointer-events-auto absolute bottom-4 left-3 rounded-full border border-neb bg-neb-wash px-2.5 py-0.5 text-xs"
        >
          {overflowOpen ? "fewer" : `+${notes.length - MAX_NOTES} more`}
        </button>
      )}
    </aside>
  );
}

/**
 * A margin note (§4.2): neb's few words in its pixel voice on its wash, with why? and got it.
 * Tapping the words opens the mark's menu (neb read and Fix, Why?, Not wrong, Hide); a "?" asks
 * whether neb read the line right.
 */
function NebNote({
  mark,
  live,
  top,
  width,
  onWhy,
}: {
  mark: Annotation;
  live: LiveAnnotator;
  top: number;
  width: number;
  onWhy(mark: Annotation): void;
}) {
  const [open, setOpen] = useState(false);
  const unsure = mark.markKind === "unsure";
  const words = unsure
    ? `i read: ${mark.recognizedText || "nothing"}. right?`
    : (mark.note ?? "check this");
  return (
    <div
      data-testid="neb-note"
      className={`pointer-events-auto absolute left-2 rounded-[10px] border-[1.5px] bg-neb-wash p-2 shadow-sh-2 transition-[top] duration-[220ms] ${
        unsure ? "border-dashed border-neb" : "border-neb"
      }`}
      style={{ top, width: Math.min(width, 160) }}
    >
      <button
        type="button"
        data-testid="live-mark"
        data-kind={mark.markKind}
        aria-label={markLabel(mark)}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="neb-voice block w-full text-left text-[13px] leading-tight"
      >
        {words}
      </button>
      {!unsure && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          <NoteButton
            neb
            onClick={() => {
              void live.askedWhy(mark.id).then((asked) => asked && onWhy(asked));
            }}
          >
            why?
          </NoteButton>
          <NoteButton onClick={() => void live.dismiss(mark.id, "hidden")}>got it</NoteButton>
        </div>
      )}
      {open && (
        <MarkMenu
          mark={mark}
          live={live}
          onWhy={onWhy}
          onClose={() => setOpen(false)}
          className="absolute top-full left-0 z-30 mt-1"
        />
      )}
    </div>
  );
}

function NoteButton({
  neb = false,
  onClick,
  children,
}: {
  neb?: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`neb-voice h-6 rounded-full px-2 text-xs ${
        neb ? "bg-neb text-white normal-case" : "border border-ink/60 text-ink"
      }`}
    >
      {children}
    </button>
  );
}
