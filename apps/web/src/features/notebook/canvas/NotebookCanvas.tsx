"use client";

import { type Camera, DEFAULT_CAMERA, panBy, screenToPage, strokeBBox, zoomAt } from "@mew/ink";
import { MAX_POINTS_PER_STROKE, type Point, type Stroke } from "@mew/shared";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { PageEngine } from "../engine";
import { studentLines } from "../export-line";
import { ERASER_RADIUS_PX, HIGHLIGHTER_WIDTH, PEN_WIDTHS } from "../palette";
import { useNotebookUi } from "../store";
import { PointerInput, type Sample } from "./input";
import { CanvasRenderer, type Theme } from "./renderer";

export type CanvasHandle = {
  zoomBy(factor: number): void;
  resetView(): void;
};

/** Ignore samples closer than this to the previous one (CSS px) to keep strokes compact. */
const MIN_SAMPLE_DISTANCE_PX = 0.75;

export const NotebookCanvas = forwardRef<CanvasHandle, { engine: PageEngine }>(
  function NotebookCanvas({ engine }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const gridRef = useRef<HTMLCanvasElement>(null);
    const inkRef = useRef<HTMLCanvasElement>(null);
    const liveRef = useRef<HTMLCanvasElement>(null);
    const controls = useRef<CanvasHandle | null>(null);

    useImperativeHandle(ref, () => ({
      zoomBy: (factor) => controls.current?.zoomBy(factor),
      resetView: () => controls.current?.resetView(),
    }));

    useEffect(() => {
      const container = containerRef.current;
      const [grid, ink, live] = [gridRef.current, inkRef.current, liveRef.current];
      if (!container || !grid || !ink || !live) return;

      const renderer = new CanvasRenderer({ grid, ink, live }, readTheme());
      let camera: Camera = DEFAULT_CAMERA;
      let draft: Stroke | null = null;
      let draftStart = 0;
      let eraser: { x: number; y: number; r: number } | null = null;
      let lastErase: [number, number] | null = null;

      // --- Frame scheduling: mark layers dirty, draw them once on the next animation frame.
      const dirty = { grid: true, ink: true, live: true };
      let frame = 0;
      const schedule = (layers: Partial<typeof dirty>) => {
        Object.assign(dirty, layers);
        frame ||= requestAnimationFrame(render);
      };
      const render = () => {
        frame = 0;
        if (dirty.grid) renderer.drawGrid(camera);
        if (dirty.ink) {
          const lines = useNotebookUi.getState().showLines ? studentLines(engine.doc) : undefined;
          renderer.drawInk(camera, engine.doc.inRegion(renderer.visible(camera)), lines);
        }
        if (dirty.live) renderer.drawLive(camera, draft, eraser);
        dirty.grid = dirty.ink = dirty.live = false;
      };
      const all = { grid: true, ink: true, live: true };

      const setCamera = (next: Camera) => {
        camera = next;
        useNotebookUi.getState().setView({ zoom: camera.zoom });
        schedule(all);
      };
      controls.current = {
        zoomBy: (factor) => {
          const { width, height } = renderer.cssSize;
          setCamera(zoomAt(camera, [width / 2, height / 2], factor));
        },
        resetView: () => setCamera(DEFAULT_CAMERA),
      };

      const toPage = (s: Sample): [number, number] => screenToPage(camera, [s.x, s.y]);
      const eraserRadius = () => ERASER_RADIUS_PX / camera.zoom;

      // --- Gestures.
      const input = new PointerInput(live, {
        onStrokeStart(sample) {
          const { tool, inkColor, highlighterColor, penSize } = useNotebookUi.getState();
          const [x, y] = toPage(sample);
          if (tool === "eraser") {
            lastErase = [x, y];
            eraser = { x, y, r: eraserRadius() };
            if (engine.eraseAlong(lastErase, lastErase, eraser.r)) schedule({ ink: true });
            schedule({ live: true });
            return;
          }
          draftStart = sample.time;
          const width = tool === "highlighter" ? HIGHLIGHTER_WIDTH : PEN_WIDTHS[penSize];
          const points: Point[] = [[round(x), round(y), sample.pressure, 0]];
          draft = {
            id: crypto.randomUUID(),
            pageId: engine.pageId,
            author: "student",
            tool,
            points,
            color: tool === "highlighter" ? highlighterColor : inkColor,
            width,
            bbox: strokeBBox(points, width),
            createdAt: Date.now(),
          };
          schedule({ live: true });
        },
        onStrokeMove(samples) {
          if (lastErase && eraser) {
            for (const sample of samples) {
              const point = toPage(sample);
              if (engine.eraseAlong(lastErase, point, eraser.r)) schedule({ ink: true });
              lastErase = point;
              eraser = { x: point[0], y: point[1], r: eraser.r };
            }
            schedule({ live: true });
            return;
          }
          if (!draft) return;
          const minDistance = MIN_SAMPLE_DISTANCE_PX / camera.zoom;
          for (const sample of samples) {
            const last = draft.points.at(-1);
            const [x, y] = toPage(sample);
            if (last && Math.hypot(x - last[0], y - last[1]) < minDistance) continue;
            if (draft.points.length >= MAX_POINTS_PER_STROKE) break;
            draft.points.push([
              round(x),
              round(y),
              sample.pressure,
              Math.round(sample.time - draftStart),
            ]);
          }
          schedule({ live: true });
        },
        onStrokeEnd() {
          if (lastErase) {
            lastErase = null;
            engine.endErase();
          } else if (draft) {
            const points = [...draft.points];
            engine.addStroke({ ...draft, points, bbox: strokeBBox(points, draft.width) });
            draft = null;
          }
          schedule({ live: true });
        },
        onStrokeCancel() {
          if (lastErase) {
            lastErase = null;
            engine.endErase();
          }
          draft = null;
          schedule({ live: true });
        },
        onPan: (dx, dy) => setCamera(panBy(camera, dx, dy)),
        onZoom: (x, y, factor) => setCamera(zoomAt(camera, [x, y], factor)),
        onHover(sample) {
          const showCursor = sample && useNotebookUi.getState().tool === "eraser";
          const [x, y] = sample ? toPage(sample) : [0, 0];
          eraser = showCursor ? { x, y, r: eraserRadius() } : null;
          schedule({ live: true });
        },
      });

      // --- Environment: size, theme, document and setting changes.
      const resize = new ResizeObserver(([entry]) => {
        if (!entry) return;
        const { width, height } = entry.contentRect;
        renderer.resize(width, height, window.devicePixelRatio || 1);
        render();
      });
      resize.observe(container);

      const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
      const onTheme = () => {
        renderer.setTheme(readTheme());
        schedule(all);
      };
      darkQuery.addEventListener("change", onTheme);

      const unsubscribeEngine = engine.subscribe(() => schedule({ ink: true }));
      const unsubscribeUi = useNotebookUi.subscribe((state, previous) => {
        if (state.showLines !== previous.showLines) schedule({ ink: true });
        if (state.tool !== previous.tool && state.tool !== "eraser") {
          eraser = null;
          schedule({ live: true });
        }
      });

      return () => {
        cancelAnimationFrame(frame);
        input.dispose();
        resize.disconnect();
        darkQuery.removeEventListener("change", onTheme);
        unsubscribeEngine();
        unsubscribeUi();
        controls.current = null;
      };
    }, [engine]);

    return (
      <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-paper">
        <canvas ref={gridRef} aria-hidden className="absolute inset-0 h-full w-full" />
        <canvas
          ref={inkRef}
          aria-hidden
          data-testid="ink-layer"
          className="absolute inset-0 h-full w-full"
        />
        <canvas
          ref={liveRef}
          role="img"
          aria-label="Notebook page. Draw with a pen, mouse or finger."
          data-testid="notebook-canvas"
          className="absolute inset-0 h-full w-full cursor-crosshair touch-none select-none"
        />
      </div>
    );
  },
);

function readTheme(): Theme {
  const styles = getComputedStyle(document.documentElement);
  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    dot: styles.getPropertyValue("--dot").trim() || "#cfc9bb",
    tutor: styles.getPropertyValue("--tutor").trim() || "#8a7bf0",
  };
}

/** Two decimals of a page unit is far below visible precision and keeps storage small. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
