"use client";

import type { Camera } from "@mew/ink";
import { type RefObject, useEffect, useRef } from "react";

import type { CanvasHandle } from "./canvas/NotebookCanvas";

/** How long the line stays marked. */
const SHOWN_MS = 8000;
/** Room above the line when the page scrolls to it (page units). */
const ABOVE = 120;

/** "Open my notes": a page and one of its lines (page units), from the desktop app. */
export type NoteSpot = { pageId: string; bbox: [number, number, number, number] };

/** Asked by the desktop app (`open_note` in lib.rs) and by `/notebook?page=…&spot=x,y,w,h`. */
export const OPEN_NOTE_EVENT = "mew:open-note";

/** A spot from the event's detail or the address, checked (ids and numbers only). */
export function readNoteSpot(value: unknown): NoteSpot | null {
  const spot = value as { pageId?: unknown; bbox?: unknown } | null;
  const id = typeof spot?.pageId === "string" ? spot.pageId : "";
  const box = Array.isArray(spot?.bbox) ? spot.bbox : [];
  if (!/^[0-9a-f-]{36}$/i.test(id) || box.length !== 4) return null;
  if (!box.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  return { pageId: id, bbox: box as NoteSpot["bbox"] };
}

/**
 * Where the student wrote about what they asked neb to do (docs/PLAN.md, "teach from your
 * notes"): the page scrolls to the line, neb's nib slides in beside it and circles it, with
 * "You wrote this", so they work from their own notes instead of being handed the answer.
 */
export function NoteSpotlight({
  canvas,
  spot,
  onDone,
}: {
  canvas: RefObject<CanvasHandle | null>;
  spot: NoteSpot;
  onDone(): void;
}) {
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    canvas.current?.showTop(Math.max(spot.bbox[1] - ABOVE, 0));
    const stop = canvas.current?.onCamera((camera: Camera) => {
      if (layer.current) {
        layer.current.style.transform = `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)`;
      }
    });
    const timer = window.setTimeout(onDone, SHOWN_MS);
    return () => {
      stop?.();
      window.clearTimeout(timer);
    };
  }, [canvas, spot, onDone]);

  const [x, y, w, h] = spot.bbox;
  const pad = 10;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-live="polite">
      <div ref={layer} className="absolute top-0 left-0 origin-top-left">
        <div
          data-testid="note-spotlight"
          className="absolute animate-[note-in_600ms_ease-out_both] rounded-[40%] border-[3px] border-neb motion-reduce:animate-none"
          style={{ left: x - pad, top: y - pad, width: w + 2 * pad, height: h + 2 * pad }}
        >
          <span className="absolute -top-8 left-0 rounded-full bg-neb px-3 py-1 text-sm whitespace-nowrap text-paper-hi">
            You wrote this
          </span>
          {/* neb's nib, arriving at the line's end (the same mark as its pointer). */}
          <svg
            viewBox="0 0 32 32"
            width={32}
            height={32}
            aria-hidden
            className="absolute -right-6 -bottom-6 animate-[nib-in_700ms_ease-out_both] text-neb motion-reduce:animate-none"
          >
            <path fill="currentColor" d="M20 29 L15 19 L22 8 L29 15 Z" />
            <path fill="var(--paper-hi)" d="M20 29 L19 24 L21 23 Z" />
          </svg>
        </div>
      </div>
    </div>
  );
}
