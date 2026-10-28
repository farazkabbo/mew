"use client";

import { type Camera, DEFAULT_CAMERA, type Vec } from "@mew/ink";
import { type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";

import type { CanvasHandle } from "./canvas/NotebookCanvas";
import { toPage } from "./circle";

/** Points closer than this (CSS px) to the last one add nothing to a loop. */
const MIN_STEP_PX = 3;

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  /** A loop finished, in page coordinates. */
  onLoop(loop: Vec[]): void;
};

/**
 * Circling your own writing while holding Ctrl+Alt (K6 §6.3): mounted only for the hold, it
 * takes the mouse, pen or finger instead of the page (nothing is written), shows each loop in the
 * student's red, and reports it on the page. Letting go of the keys unmounts it.
 */
export function HoldCircle({ canvas, onLoop }: Props) {
  const camera = useRef<Camera>(DEFAULT_CAMERA);
  const drawing = useRef<Vec[] | null>(null);
  const [loops, setLoops] = useState<Vec[][]>([]);

  useEffect(() => {
    return canvas.current?.onCamera((next) => {
      camera.current = next;
    });
  }, [canvas]);

  const at = (event: PointerEvent<HTMLDivElement>): Vec => {
    const box = event.currentTarget.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const loop = [at(event)];
    drawing.current = loop;
    setLoops((all) => [...all, loop]);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const loop = drawing.current;
    const last = loop?.at(-1);
    if (!loop || !last) return;
    const point = at(event);
    if (Math.hypot(point[0] - last[0], point[1] - last[1]) < MIN_STEP_PX) return;
    const next = [...loop, point];
    drawing.current = next;
    setLoops((all) => [...all.slice(0, -1), next]);
  };

  const onPointerUp = () => {
    const loop = drawing.current;
    drawing.current = null;
    if (loop && loop.length >= 3) onLoop(loop.map((p) => toPage(p, camera.current)));
  };

  return (
    <div
      data-testid="hold-circle"
      className="absolute inset-0 cursor-crosshair touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden>
        {loops.map((loop, i) => (
          <polyline
            key={i}
            points={loop.map(([x, y]) => `${x},${y}`).join(" ")}
            className="fill-none stroke-neb"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      <p
        role="status"
        className="pointer-events-none absolute inset-x-0 top-20 mx-auto w-fit rounded-full bg-ink px-4 py-2 text-sm text-paper shadow-lg"
      >
        Circle your writing and ask — let go to send
      </p>
    </div>
  );
}
