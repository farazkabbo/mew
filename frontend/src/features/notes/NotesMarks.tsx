"use client";

import { type RefObject, useEffect, useRef, useState } from "react";

import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import type { NotebookDb } from "../notebook/db";
import { FindingCard } from "./FindingCard";
import type { HeadingInk } from "./follow-up";
import type { PageMark } from "./marks";

/** Notes Check's amber ("look at this again"); violet is the tutor's own colour. */
const AMBER = "#d97706";
const VIOLET = "var(--tutor, #8a7bf0)";

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  marks: readonly PageMark[];
  /** A finding just asked for (from the panel or the desktop app): it pulses for a moment. */
  focusId: string | null;
  db: NotebookDb;
  /** Writes a gap's heading as tutor ink (none while the tutor's ink isn't available). */
  ink: HeadingInk | null;
};

/**
 * Notes Check's marks over the notebook page (N4, brief §8): a layer of its own above the ink,
 * following the canvas camera with one CSS transform, so marks are positioned in page units and
 * never touch the student's strokes. Only the "?", "+", ticks and link chips take the pointer;
 * the rest of the layer lets the pen through to the page. A settled finding is a faint tick.
 */
export function NotesMarks({ canvas, marks, focusId, db, ink }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  useEffect(() => {
    if (!openId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId]);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="notes-marks">
      <div ref={layer} className="absolute top-0 left-0 origin-top-left">
        {marks.map((mark) => {
          const [x, y, w, h] = mark.box;
          const pulsing = mark.findingId === focusId;
          const open = mark.findingId === openId;
          const toggle = () => setOpenId(open ? null : mark.findingId);
          const close = () => setOpenId(null);
          const card = (kind: "question" | "gap", question: string) => (
            <FindingCard
              findingId={mark.findingId}
              kind={kind}
              question={question}
              db={db}
              ink={ink}
              onClose={close}
            />
          );
          switch (mark.kind) {
            case "question":
              return (
                <div
                  key={mark.findingId}
                  data-testid="mark-question"
                  data-settled={mark.settled || undefined}
                >
                  {mark.settled ? (
                    <SettledTick x={x + w + 6} y={y + h / 2 - 12} onClick={toggle} open={open} />
                  ) : (
                    <>
                      <div
                        className={`absolute ${pulsing ? "animate-pulse" : ""}`}
                        style={{
                          left: x,
                          top: y + h + 2,
                          width: w,
                          borderBottom: `2px dotted ${AMBER}`,
                        }}
                      />
                      <button
                        type="button"
                        onClick={toggle}
                        aria-expanded={open}
                        aria-label={`Question about this line: ${mark.question}`}
                        className="pointer-events-auto absolute grid size-6 place-items-center rounded-full text-sm font-semibold text-white shadow"
                        style={{ left: x + w + 6, top: y + h / 2 - 12, background: AMBER }}
                      >
                        ?
                      </button>
                    </>
                  )}
                  {open && (
                    <Card x={x + w + 36} y={y - 8} onClose={close}>
                      {card("question", mark.question)}
                    </Card>
                  )}
                </div>
              );
            case "gap":
              return (
                <div
                  key={mark.findingId}
                  data-testid="mark-gap"
                  data-settled={mark.settled || undefined}
                >
                  {mark.settled ? (
                    <SettledTick x={x - 32} y={y + h + 6} onClick={toggle} open={open} />
                  ) : (
                    <button
                      type="button"
                      onClick={toggle}
                      aria-expanded={open}
                      aria-label={`Not in your notes yet: ${mark.question}`}
                      className={`pointer-events-auto absolute grid size-6 place-items-center rounded-full border-2 bg-paper text-base font-semibold ${pulsing ? "animate-pulse" : ""}`}
                      style={{ left: x - 32, top: y + h + 6, borderColor: VIOLET, color: VIOLET }}
                    >
                      +
                    </button>
                  )}
                  {open && (
                    <Card x={x} y={y + h + 8} onClose={close}>
                      {card("gap", mark.question)}
                    </Card>
                  )}
                </div>
              );
            case "match":
              return (
                <div key={mark.findingId} data-testid="mark-match">
                  <div
                    aria-hidden
                    className={`absolute ${pulsing ? "animate-pulse" : ""}`}
                    style={{
                      left: x - 10,
                      top: y - 2,
                      width: 6,
                      height: h + 4,
                      border: `1.5px solid ${VIOLET}`,
                      borderRight: "none",
                      borderRadius: "4px 0 0 4px",
                    }}
                  />
                  {mark.link &&
                    (mark.link.href ? (
                      <a
                        href={mark.link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Matches your source: ${mark.link.label}`}
                        className="pointer-events-auto absolute max-w-48 truncate rounded-full bg-paper/90 px-2 py-0.5 text-[10px] text-muted shadow-sm ring-1 ring-ink/10"
                        style={{ left: x + w + 8, top: y + h / 2 - 9 }}
                      >
                        ✓ {mark.link.label}
                      </a>
                    ) : (
                      <span
                        className="absolute max-w-48 truncate rounded-full bg-paper/90 px-2 py-0.5 text-[10px] text-muted ring-1 ring-ink/10"
                        style={{ left: x + w + 8, top: y + h / 2 - 9 }}
                      >
                        ✓ {mark.link.label}
                      </span>
                    ))}
                </div>
              );
          }
        })}
      </div>
    </div>
  );
}

/** A settled finding: a faint tick that still opens what was said about it. */
function SettledTick({
  x,
  y,
  open,
  onClick,
}: {
  x: number;
  y: number;
  open: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label="Worked through"
      className="pointer-events-auto absolute grid size-6 place-items-center text-sm opacity-40"
      style={{ left: x, top: y, color: VIOLET }}
    >
      ✓
    </button>
  );
}

function Card({
  x,
  y,
  onClose,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label="Notes Check"
      className="pointer-events-auto absolute w-64 rounded-xl bg-paper p-3 text-sm text-ink shadow-lg ring-1 ring-ink/10"
      style={{ left: x, top: y }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="float-right -mt-1 -mr-1 px-1 text-muted"
      >
        ×
      </button>
      {children}
    </div>
  );
}
