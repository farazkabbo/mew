"use client";

import type { ImageBlock } from "@mew/shared";
import { Fragment, type RefObject, useEffect, useRef, useState } from "react";

import type { CanvasHandle } from "./canvas/NotebookCanvas";
import { HEADING_SPACE } from "./clip-page";
import { replayEntry, type ReplayStep } from "./entry-replay";
import { useNotebookUi } from "./store";

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  /** The page's images: those that are Circle & Ask entries get their note. */
  images: readonly ImageBlock[];
};

/**
 * The explanation under each Circle & Ask entry's picture (S3.2 §5): the question, its steps,
 * the summary and a question to check, with Replay to watch the tutor's ink draw itself again
 * step by step. A layer above the page that follows the camera (like Notes Check's marks), so
 * the note stays under its picture; only the notes take the pointer.
 */
export function EntryNotes({ canvas, images }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const [replaying, setReplaying] = useState<{ imageId: string; step: ReplayStep | null } | null>(
    null,
  );
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  // A replay never outlives the page it's on.
  useEffect(() => () => stop.current?.(), []);

  const entries = images.filter((image) => image.entry);
  if (entries.length === 0) return null;

  const replay = (image: ImageBlock) => {
    if (!image.entry) return;
    stop.current?.();
    setReplaying({ imageId: image.id, step: null });
    stop.current = replayEntry(
      image.entry,
      (groups) => useNotebookUi.getState().setReplayHidden(groups),
      (step) => setReplaying(step ? { imageId: image.id, step } : null),
    );
  };

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="entry-notes">
      <div ref={layer} className="absolute top-0 left-0 origin-top-left">
        {entries.map((image) => {
          const entry = image.entry;
          if (!entry) return null;
          const current = replaying?.imageId === image.id ? replaying.step : null;
          return (
            <Fragment key={image.id}>
              {entry.heading && (
                // A day's first entry on a "From screen" page (K3).
                <h3
                  data-testid="entry-day"
                  className="absolute font-serif text-lg text-ink-muted"
                  style={{ left: image.x, top: image.y - HEADING_SPACE + 4 }}
                >
                  {entry.heading}
                </h3>
              )}
              <section
                data-testid="entry-note"
                aria-label="Explanation from your screen"
                className="pointer-events-auto absolute rounded-xl bg-paper/95 px-4 py-3 text-sm leading-snug text-ink shadow-sm ring-1 ring-ink/10"
                style={{ left: image.x, top: image.y + image.height + 8, width: image.width }}
              >
                {entry.turns.map((turn, t) => (
                  <div key={t} className={t > 0 ? "mt-3 border-t border-ink/10 pt-3" : undefined}>
                    <p className="font-semibold">{turn.question}</p>
                    <ol className="mt-1 list-decimal pl-5">
                      {turn.steps.map((step, s) => (
                        <li
                          key={s}
                          data-current={(current?.turn === t && current.step === s) || undefined}
                          className="rounded px-1 data-[current]:bg-[var(--tutor,#8a7bf0)]/20"
                        >
                          {step}
                        </li>
                      ))}
                    </ol>
                    <p className="mt-1 text-ink-muted">{turn.summary}</p>
                    {turn.followUpQuestion && (
                      <p className="mt-1">
                        <span className="font-medium">To check:</span> {turn.followUpQuestion}
                      </p>
                    )}
                  </div>
                ))}
                <button
                  type="button"
                  className="mt-2 font-medium underline underline-offset-2"
                  onClick={() =>
                    replaying?.imageId === image.id ? stop.current?.() : replay(image)
                  }
                >
                  {replaying?.imageId === image.id ? "Stop replay" : "Replay"}
                </button>
              </section>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
