"use client";

import type { Stroke } from "@mew/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import type { PageEngine } from "../notebook/engine";
import { pageReplayPlan } from "../notebook/page-replay";

/** Gaps longer than this aren't writing (a break, another day): not counted as time spent. */
const IDLE_MS = 30_000;
const SPEEDS = [1, 2, 4] as const;

/** "6:41 of writing": the strokes' own time, without the breaks between them. */
export function writingTime(strokes: readonly Pick<Stroke, "createdAt" | "author">[]): number {
  const times = strokes
    .filter((s) => s.author === "student")
    .map((s) => s.createdAt)
    .sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] as number) - (times[i - 1] as number);
    if (gap > 0 && gap < IDLE_MS) total += gap;
  }
  return total;
}

export function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The strokes still hidden when the replay is at `t` (ms into it). */
export function hiddenAt(frames: ReturnType<typeof pageReplayPlan>, t: number): Set<string> {
  const hidden = new Set<string>();
  for (const frame of frames) if (frame.at > t) for (const id of frame.ids) hidden.add(id);
  return hidden;
}

/**
 * The replay bar under the sheet (docs/NEB_APP_UI.md §4.8): "Replay this page", a track with the
 * written part, violet ticks for neb's marks and ink diamonds for saved moments, and a scrubber
 * that redraws the page as it was at that moment (ink and marks in order). 1×, 2×, 4×; Space
 * plays and pauses while the bar has focus.
 */
export function ReplayBar({
  engine,
  moments,
  onHide,
}: {
  engine: Pick<PageEngine, "doc" | "subscribe">;
  /** When moments (screen entries) were added to this page. */
  moments: readonly number[];
  /** The strokes to hide right now (null shows the page as it is). */
  onHide(ids: ReadonlySet<string> | null): void;
}) {
  // The page's strokes, read again whenever it changes.
  const [version, setVersion] = useState(0);
  useEffect(() => engine.subscribe(() => setVersion((v) => v + 1)), [engine]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const strokes = useMemo(() => engine.doc.all(), [engine, version]);
  const frames = useMemo(() => pageReplayPlan(strokes), [strokes]);
  const total = frames.at(-1)?.at ?? 0;
  const [t, setT] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const raf = useRef(0);

  // Where each mark and moment falls on the track (by the replay's own time).
  const marks = useMemo(() => {
    const at = new Map<string, number>();
    for (const f of frames) for (const id of f.ids) at.set(id, f.at);
    const groups = new Set<string>();
    return strokes
      .filter(
        (s) =>
          s.markKind &&
          s.markKind !== "tick" &&
          s.groupId &&
          !groups.has(s.groupId) &&
          groups.add(s.groupId),
      )
      .map((s) => at.get(s.id) ?? 0);
  }, [frames, strokes]);
  const momentsAt = useMemo(() => {
    const first = strokes.reduce((m, s) => Math.min(m, s.createdAt), Infinity);
    const last = strokes.reduce((m, s) => Math.max(m, s.createdAt), 0);
    if (!Number.isFinite(first) || last <= first) return [];
    return moments.map((m) => ((m - first) / (last - first)) * total);
  }, [moments, strokes, total]);

  // Playing: the scrubber moves on its own, then the page shows as it is again.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const step = (now: number) => {
      setT((current) => {
        const next = (current ?? 0) + (now - last) * speed;
        last = now;
        if (next >= total) {
          setPlaying(false);
          return null;
        }
        return next;
      });
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [playing, speed, total]);

  useEffect(() => {
    onHide(t === null ? null : hiddenAt(frames, t));
  }, [t, frames, onHide]);
  useEffect(() => () => onHide(null), [onHide]);

  const fraction = t === null ? 1 : total > 0 ? t / total : 1;
  const nebMarks = marks.length;
  const pct = (at: number) => `${total > 0 ? (at / total) * 100 : 0}%`;

  return (
    <div
      data-testid="replay-bar"
      className="@container pointer-events-auto flex h-11 min-w-0 flex-1 items-center gap-4"
      onKeyDown={(event) => {
        if (event.key === " " && event.target === event.currentTarget) {
          event.preventDefault();
          setPlaying((p) => !p);
        }
      }}
    >
      <button
        type="button"
        onClick={() => {
          if (playing) {
            setPlaying(false);
            setT(null);
            return;
          }
          setT(0);
          setPlaying(true);
        }}
        disabled={strokes.length === 0}
        aria-label={playing ? "Stop the replay" : "Replay this page (how it was solved)"}
        className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-ink px-3.5 text-[13px] font-medium text-paper disabled:opacity-40"
      >
        {playing ? "■ Stop" : "◀◀ Replay this page"}
      </button>
      <div className="relative h-6 min-w-[120px] flex-1">
        <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-full bg-line" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-[#9A927F]"
          style={{ width: `${fraction * 100}%` }}
        />
        {marks.map((at, i) => (
          <span
            key={`m${i}`}
            aria-hidden
            className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-neb"
            style={{ left: pct(at) }}
          />
        ))}
        {momentsAt.map((at, i) => (
          <span
            key={`d${i}`}
            aria-hidden
            className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-ink"
            style={{ left: pct(at) }}
          />
        ))}
        <input
          type="range"
          aria-label="Replay position"
          min={0}
          max={Math.max(1, total)}
          value={t ?? total}
          onChange={(event) => {
            setPlaying(false);
            const value = Number(event.target.value);
            setT(value >= total ? null : value);
          }}
          className="absolute inset-0 w-full cursor-pointer opacity-0"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-paper bg-ink shadow-sh-1"
          style={{ left: `${fraction * 100}%` }}
        />
      </div>
      <div
        role="radiogroup"
        aria-label="Replay speed"
        className="hidden shrink-0 gap-0.5 text-xs @[30rem]:flex"
      >
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={speed === s}
            onClick={() => setSpeed(s)}
            className="h-7 rounded-full px-2 text-muted aria-checked:bg-ink aria-checked:text-paper"
          >
            {s}×
          </button>
        ))}
      </div>
      <span className="hidden shrink-0 text-[13px] text-muted tabular-nums @[46rem]:inline">
        {clock(writingTime(strokes))} of writing · {nebMarks} neb{" "}
        {nebMarks === 1 ? "mark" : "marks"}
      </span>
    </div>
  );
}
