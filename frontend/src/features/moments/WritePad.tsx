"use client";

import { strokeBBox } from "@mew/ink";
import type { Point, Recognition, Stroke } from "@mew/shared";
import { Recognition as RecognitionSchema } from "@mew/shared";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { strokesImage } from "../tutor/recognition";

const PAD_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Writing a Quick check answer by hand (K8 §4.7: "typing, speaking, or writing"): a small pad,
 * read by the same handwriting recognition as the notebook. What it read goes into the answer box
 * for the student to check before sending.
 */
export function WritePad({ onRead }: { onRead(text: string): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Point[] | null>(null);
  const [state, setState] = useState<"empty" | "written" | "reading" | "failed">("empty");

  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return [
      event.clientX - box.left,
      event.clientY - box.top,
      event.pressure || 0.5,
      event.timeStamp,
    ];
  };
  const draw = () => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx || !canvas.current) return;
    ctx.clearRect(0, 0, canvas.current.width, canvas.current.height);
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(canvas.current).color;
    const paths = [
      ...strokes.current.map((s) => s.points),
      ...(current.current ? [current.current] : []),
    ];
    for (const points of paths) {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
  };
  const read = async () => {
    const all = strokes.current;
    if (all.length === 0) return;
    setState("reading");
    try {
      // The same picture as a notebook line (K10 §8.2).
      const image = await strokesImage(all);
      if (!image) throw new Error("no ink");
      const response = await fetch("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`recognize ${response.status}`);
      const reading: Recognition = RecognitionSchema.parse(await response.json());
      onRead((reading.latex ?? reading.text).trim() || reading.text);
      setState("written");
    } catch {
      setState("failed");
    }
  };

  return (
    <div className="flex flex-col gap-1" data-testid="quick-check-pad">
      <canvas
        ref={canvas}
        width={440}
        height={110}
        aria-label="Write your answer here"
        className="w-full touch-none rounded-xl border border-dashed border-rule bg-paper text-ink"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          current.current = [point(event)];
        }}
        onPointerMove={(event) => {
          if (!current.current) return;
          current.current.push(point(event));
          draw();
        }}
        onPointerUp={() => {
          const points = current.current;
          current.current = null;
          if (!points || points.length < 2) return;
          strokes.current.push({
            id: crypto.randomUUID(),
            pageId: PAD_ID,
            author: "student",
            tool: "pen",
            points,
            color: "#1d1c1a",
            width: 3,
            bbox: strokeBBox(points, 3),
            createdAt: strokes.current.length,
          });
          setState("written");
          draw();
        }}
      />
      <div className="flex items-center gap-2 text-xs">
        <button
          type="button"
          disabled={state === "empty" || state === "reading"}
          onClick={() => void read()}
          className="rounded-full border border-rule px-3 py-1 hover:border-accent disabled:opacity-50"
        >
          {state === "reading" ? (
            <Loader2 className="inline size-3.5 animate-spin" aria-hidden />
          ) : (
            "Read my writing"
          )}
        </button>
        <button
          type="button"
          disabled={state === "empty"}
          onClick={() => {
            strokes.current = [];
            setState("empty");
            draw();
          }}
          className="text-ink-muted hover:text-ink disabled:opacity-50"
        >
          Clear
        </button>
        {state === "failed" && (
          <span role="alert" className="text-error">
            Couldn&apos;t read it. Try again, or type it.
          </span>
        )}
      </div>
    </div>
  );
}
