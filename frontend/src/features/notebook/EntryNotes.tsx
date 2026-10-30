"use client";

import type { Camera } from "@mew/ink";
import type { ImageBlock } from "@mew/shared";
import { Fragment, type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { loadMomentAudio, MOMENT_AUDIO_RATE } from "../moments/api";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import type { CanvasHandle } from "./canvas/NotebookCanvas";
import { HEADING_SPACE } from "./clip-page";
import { replayEntry, type ReplayStep } from "./entry-replay";
import { useNotebookUi } from "./store";

/** Turns and steps a moment's voice is kept for (the audio route's own bounds). */
const VOICED = { turns: 3, steps: 5 } as const;

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  /** The page's images: those that are Circle & Ask entries get their note. */
  images: readonly ImageBlock[];
};

/**
 * The explanation under each Circle & Ask entry's picture (S3.2 §5): the question, its steps,
 * the summary and a question to check, with Replay to watch the tutor's ink draw itself again
 * step by step, said in the voice it was first said in when that was kept (K8 §4.7). A moment
 * opened from elsewhere (Moments, Ctrl+K, a Quick check) is scrolled to, and replayed if asked. A layer above the page that follows the camera (like Notes Check's marks), so
 * the note stays under its picture; only the notes take the pointer.
 */
export function EntryNotes({ canvas, images }: Props) {
  const layer = useRef<HTMLDivElement | null>(null);
  const camera = useRef<Camera | null>(null);
  const [replaying, setReplaying] = useState<{ imageId: string; step: ReplayStep | null } | null>(
    null,
  );
  const stop = useRef<(() => void) | null>(null);
  const player = useRef<PcmStreamPlayer | null>(null);

  useEffect(() => {
    return canvas.current?.onCamera((next) => {
      camera.current = next;
      follow(layer.current, next);
    });
  }, [canvas]);

  // The layer only exists while the page has entries: when it appears, it takes the camera the
  // page already has, or the notes would sit at the screen's origin until the next scroll.
  const attach = useCallback((element: HTMLDivElement | null) => {
    layer.current = element;
    follow(element, camera.current);
  }, []);

  // A replay never outlives the page it's on.
  useEffect(() => () => stop.current?.(), []);

  const replay = useCallback((image: ImageBlock) => {
    if (!image.entry) return;
    stop.current?.();
    setReplaying({ imageId: image.id, step: null });
    const clipId = image.clipId;
    const abort = new AbortController();
    player.current ??= new PcmStreamPlayer();
    const voice = player.current;
    const finish = replayEntry(
      image.entry,
      (groups) => useNotebookUi.getState().setReplayHidden(groups),
      (step) => setReplaying(step ? { imageId: image.id, step } : null),
      undefined,
      async ({ turn, step }) => {
        if (!clipId || turn >= VOICED.turns || step >= VOICED.steps) return false;
        const stream = await loadMomentAudio(clipId, turn, step, abort.signal);
        if (!stream || abort.signal.aborted) return false;
        await voice.play(stream, { sampleRate: MOMENT_AUDIO_RATE, signal: abort.signal });
        return true;
      },
    );
    stop.current = () => {
      abort.abort();
      voice.stop();
      finish();
    };
  }, []);

  // K8: a moment asked for from elsewhere, once its page is open.
  const request = useNotebookUi((s) => s.momentRequest);
  useEffect(() => {
    if (!request) return;
    const image = images.find((i) => i.id === request.imageId);
    if (!image) return;
    useNotebookUi.getState().requestMoment(null);
    canvas.current?.showTop(image.y - (image.entry?.heading ? HEADING_SPACE : 0));
    // After this render: the replay's first state change belongs to the next one.
    if (request.replay) queueMicrotask(() => replay(image));
  }, [request, images, canvas, replay]);

  const entries = images.filter((image) => image.entry);
  if (entries.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" data-testid="entry-notes">
      <div ref={attach} className="absolute top-0 left-0 origin-top-left">
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
                  className="absolute font-serif text-lg text-muted"
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
                          className="rounded px-1 data-[current]:bg-neb/20"
                        >
                          {step}
                        </li>
                      ))}
                    </ol>
                    <p className="mt-1 text-muted">{turn.summary}</p>
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

/** Moves the notes with the page (one CSS transform, page units inside). */
function follow(element: HTMLDivElement | null, camera: Camera | null) {
  if (element && camera)
    element.style.transform = `scale(${camera.zoom}) translate(${-camera.x}px, ${-camera.y}px)`;
}
