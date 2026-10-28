"use client";

import type { Stroke } from "@mew/shared";
import { type RefObject, useEffect, useRef, useState } from "react";

import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import type { LiveAnnotator } from "./annotator";

/**
 * "neb read: 3x + 7 = 19" (K10 §8.2) for a line selected with the lasso, marked or not, in small
 * grey under it, with Fix: typing what it really says checks the line again and teaches neb the
 * student's handwriting (§8.3). Follows the camera like the mark layer.
 */
export function ReadAsChip({
  canvas,
  live,
  selection,
}: {
  canvas: RefObject<CanvasHandle | null>;
  live: LiveAnnotator;
  selection: readonly Stroke[] | null;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [read, setRead] = useState<{ key: string; text: string } | null>(null);
  /** The selection being fixed (a new selection closes the form). */
  const [fixingKey, setFixingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const key = selection?.map((s) => s.id).join(",") ?? "";

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  useEffect(() => {
    if (!selection?.length) return;
    let current = true;
    void live.readingOf(selection.map((s) => s.id)).then((reading) => {
      if (current) setRead(reading?.text.trim() ? { key, text: reading.text } : null);
    });
    return () => {
      current = false;
    };
  }, [live, selection, key]);

  if (!selection?.length || read?.key !== key) return null;
  const fixing = fixingKey === key;
  const setFixing = (on: boolean) => setFixingKey(on ? key : null);
  const box = selection
    .map((s) => s.bbox)
    .reduce((a, b) => [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0] + a[2], b[0] + b[2]) - Math.min(a[0], b[0]),
      Math.max(a[1] + a[3], b[1] + b[3]) - Math.min(a[1], b[1]),
    ]);

  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      data-testid="read-as-chip"
    >
      <div ref={layer} className="absolute top-0 left-0 origin-top-left">
        <div
          className="pointer-events-auto absolute flex items-center gap-2 rounded-lg border border-rule bg-paper-raised px-2 py-1 text-xs text-ink-muted shadow-sm"
          style={{ left: box[0], top: box[1] + box[3] + 6 }}
        >
          {fixing ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (!draft.trim()) return;
                setFixing(false);
                setRead({ key, text: draft.trim() });
                void live.fixLine(
                  selection.map((s) => s.id),
                  draft,
                );
              }}
            >
              <label htmlFor="read-as-fix">It says</label>
              <input
                id="read-as-fix"
                autoFocus
                maxLength={300}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => event.key === "Escape" && setFixing(false)}
                className="w-48 rounded border border-rule bg-paper px-1.5 py-0.5 text-ink"
              />
              <button type="submit" className="rounded-full bg-ink px-2 py-0.5 text-paper">
                Check it
              </button>
            </form>
          ) : (
            <>
              <span>
                neb read: <span className="font-mono text-ink">{read.text}</span>
              </span>
              <button
                type="button"
                className="underline hover:text-ink"
                onClick={() => {
                  setDraft(read.text);
                  setFixing(true);
                }}
              >
                Fix
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
