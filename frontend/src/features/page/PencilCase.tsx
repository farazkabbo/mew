"use client";

import { Eraser, Highlighter, LassoSelect, type LucideIcon, Pen, Redo2, Undo2 } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import {
  HIGHLIGHTER_COLORS,
  INK_COLORS,
  PEN_WIDTHS,
  type PenSize,
  type Tool,
} from "../notebook/palette";
import { useNotebookUi } from "../notebook/store";
import { useShortcutKeys } from "../shortcuts/useShortcutKeys";

const TOOLS: { tool: Tool; label: string; icon: LucideIcon }[] = [
  { tool: "pen", label: "Pen", icon: Pen },
  { tool: "highlighter", label: "Highlighter", icon: Highlighter },
  { tool: "eraser", label: "Eraser", icon: Eraser },
  { tool: "lasso", label: "Lasso select", icon: LassoSelect },
];
/** The three pens on the case (§4.6); green is kept behind a long-press on them. */
const CASE_INKS = INK_COLORS.slice(0, 3);
const HAND_KEY = "neb:writing-hand";
/** §4.6: after this long writing without a pause, the case shrinks to a tab. */
const COLLAPSE_AFTER_MS = 8000;

export type WritingHand = "right" | "left";

/** Keeps the writing hand on this device (the case and onboarding both set it). */
export function saveWritingHand(hand: WritingHand) {
  try {
    localStorage.setItem(HAND_KEY, hand);
  } catch {
    // This session only.
  }
}

export function readWritingHand(): WritingHand {
  try {
    return localStorage.getItem(HAND_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

/**
 * The pencil case (docs/NEB_APP_UI.md §4.6, board 2): a vertical ink pill on the side away from
 * the writing hand. Pen, highlighter, eraser, lasso, then circle & ask (the only violet button),
 * the pens' colours, undo and redo, and the hand. A second tap on the pen opens its sizes; a
 * long-press on the colours shows the rest. It shrinks to a tab after 8 s of writing.
 */
export function PencilCase({
  hand,
  onHand,
  onUndo,
  onRedo,
  onCircle,
  writing,
}: {
  hand: WritingHand;
  onHand(hand: WritingHand): void;
  onUndo(): void;
  onRedo(): void;
  /** Circle & ask: the same as holding Ctrl + Alt on the page. */
  onCircle(): void;
  /** When the student last put ink down (0: not writing). */
  writing: number;
}) {
  const { tool, inkColor, highlighterColor, penSize, canUndo, canRedo } = useNotebookUi();
  const { setTool, setColor, setPenSize } = useNotebookUi.getState();
  const keys = useShortcutKeys();
  const [sizes, setSizes] = useState(false);
  const [moreColours, setMoreColours] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // §4.6: shrinks after 8 s of continuous writing; any hover or tap brings it back.
  useEffect(() => {
    if (!writing) return;
    const timer = setTimeout(() => setCollapsed(true), COLLAPSE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [writing]);

  const colours =
    tool === "highlighter" ? HIGHLIGHTER_COLORS : moreColours ? INK_COLORS : CASE_INKS;
  const activeColour = tool === "highlighter" ? highlighterColor : inkColor;

  if (collapsed) {
    return (
      <button
        type="button"
        aria-label="Show the pencil case"
        onPointerEnter={() => setCollapsed(false)}
        onClick={() => setCollapsed(false)}
        className="pointer-events-auto h-24 w-3 rounded-full bg-ink shadow-sh-3"
      />
    );
  }

  return (
    <div
      role="toolbar"
      aria-label="Drawing tools"
      aria-orientation="vertical"
      data-testid="pencil-case"
      className="pointer-events-auto flex w-[60px] flex-col items-center gap-1.5 rounded-full bg-ink px-2 py-3 text-paper shadow-sh-3"
    >
      {TOOLS.map(({ tool: t, label, icon }) => (
        <CaseButton
          key={t}
          icon={icon}
          label={`${label} (${keys.shown(t)})`}
          keytip={keys.shown(t)}
          pressed={tool === t}
          onClick={() => {
            if (t === "pen" && tool === "pen") setSizes((v) => !v);
            else setSizes(false);
            setTool(t);
          }}
        />
      ))}
      {sizes && tool === "pen" && (
        <div role="radiogroup" aria-label="Pen size" className="flex flex-col items-center gap-1">
          {(Object.keys(PEN_WIDTHS) as PenSize[]).map((size) => (
            <button
              key={size}
              type="button"
              role="radio"
              aria-checked={penSize === size}
              aria-label={`Size ${size}`}
              onClick={() => setPenSize(size)}
              className="grid size-8 place-items-center rounded-full aria-checked:bg-paper/20"
            >
              <span
                className="rounded-full bg-current"
                style={{ width: PEN_WIDTHS[size] * 1.6, height: PEN_WIDTHS[size] * 1.6 }}
              />
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={onCircle}
        aria-label="Circle and ask (hold Ctrl+Alt)"
        title="Circle and ask (hold Ctrl+Alt on the page) · or say “what's this?”"
        className="grid size-11 place-items-center rounded-full bg-neb text-white transition-opacity duration-[120ms] hover:opacity-90"
      >
        <svg
          viewBox="0 0 24 24"
          className="size-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeDasharray="3 2.4"
          aria-hidden
        >
          <ellipse cx="12" cy="11" rx="8" ry="6" />
        </svg>
      </button>
      <Divider />
      <div
        role="radiogroup"
        aria-label="Colour"
        className="flex flex-col items-center gap-1"
        onContextMenu={(event) => {
          event.preventDefault();
          setMoreColours((v) => !v);
        }}
      >
        {colours.map((c) => (
          <button
            key={c.name}
            type="button"
            role="radio"
            aria-checked={activeColour === c.light}
            aria-label={c.name}
            title={tool === "highlighter" ? c.name : `${c.name} (right-click for more)`}
            disabled={tool === "eraser" || tool === "lasso"}
            onClick={() => setColor(c.light)}
            className="grid size-8 place-items-center rounded-full disabled:opacity-40 aria-checked:ring-2 aria-checked:ring-paper"
          >
            <span
              className="size-[18px] rounded-full border border-paper/30 bg-(--swatch-light) dark:bg-(--swatch-dark)"
              style={{ "--swatch-light": c.light, "--swatch-dark": c.dark } as CSSProperties}
            />
          </button>
        ))}
      </div>
      <Divider />
      <CaseButton
        icon={Undo2}
        label={`Undo (${keys.shown("undo")})`}
        keytip={keys.shown("undo")}
        disabled={!canUndo}
        onClick={onUndo}
      />
      <CaseButton
        icon={Redo2}
        label={`Redo (${keys.shown("redo")})`}
        keytip={keys.shown("redo")}
        disabled={!canRedo}
        onClick={onRedo}
      />
      <Divider />
      <button
        type="button"
        onClick={() => {
          const next = hand === "right" ? "left" : "right";
          saveWritingHand(next);
          onHand(next);
        }}
        aria-label={`Writing hand: ${hand}. The case sits on the ${hand === "right" ? "left" : "right"}.`}
        className="h-7 rounded-full px-1 text-[11px] font-semibold text-paper/80 hover:text-paper"
      >
        {hand === "right" ? "R hand" : "L hand"}
      </button>
    </div>
  );
}

function CaseButton({
  icon: Icon,
  label,
  keytip,
  pressed,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  /** Its keys, shown while Alt is held (§5.6). */
  keytip?: string;
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
      data-keytip={keytip}
      onClick={onClick}
      className="grid size-11 place-items-center rounded-full text-paper/80 transition-colors duration-[120ms] hover:bg-paper/10 hover:text-paper disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-paper aria-pressed:text-ink"
    >
      <Icon className="size-5" strokeWidth={1.8} aria-hidden />
    </button>
  );
}

function Divider(): ReactNode {
  return <span aria-hidden className="my-0.5 h-px w-6 bg-paper/20" />;
}
