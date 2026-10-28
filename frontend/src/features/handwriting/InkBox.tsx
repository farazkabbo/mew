"use client";

import type { Point } from "@mew/shared";
import { useEffect, useRef } from "react";

/**
 * A small box to write one thing in (calibration): pen, finger or mouse. Reports its strokes
 * after each one; `clearKey` changing empties it.
 */
export function InkBox({
  label,
  width,
  height,
  onChange,
  clearKey = 0,
}: {
  label: string;
  width: number;
  height: number;
  onChange(strokes: Point[][]): void;
  clearKey?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const current = useRef<Point[] | null>(null);

  const draw = () => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    ctx.clearRect(0, 0, element.width, element.height);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = getComputedStyle(element).color;
    for (const points of [...strokes.current, ...(current.current ? [current.current] : [])]) {
      ctx.beginPath();
      points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
      ctx.stroke();
    }
  };

  useEffect(() => {
    strokes.current = [];
    current.current = null;
    draw();
  }, [clearKey]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    const sx = width / box.width;
    const sy = height / box.height;
    return [
      (event.clientX - box.left) * sx,
      (event.clientY - box.top) * sy,
      event.pressure || 0.5,
      event.timeStamp,
    ];
  };

  return (
    <canvas
      ref={canvas}
      width={width}
      height={height}
      aria-label={label}
      className="touch-none rounded-md border border-rule bg-paper text-ink"
      style={{ width, height }}
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
        if (!points) return;
        // A tap is a dot (the i's, a decimal point): keep it as a tiny stroke.
        strokes.current.push(points.length > 1 ? points : [...points, points[0] as Point]);
        draw();
        onChange([...strokes.current]);
      }}
    />
  );
}
