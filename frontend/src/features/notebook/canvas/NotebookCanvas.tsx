"use client";

import { type Camera, DEFAULT_CAMERA, panBy, screenToPage, zoomAt } from "@mew/ink";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { PageEngine } from "../engine";
import { studentLines } from "../export-line";
import type { Tool } from "../palette";
import { useNotebookUi } from "../store";
import { PointerInput, type Sample } from "./input";
import { CanvasRenderer, type Theme } from "./renderer";
import { EraserTool } from "./tools/eraser";
import { LassoTool } from "./tools/lasso";
import { PenTool } from "./tools/pen";
import type { Overlay, PagePoint, ToolContext, ToolController } from "./tools/types";
import { isTypingTarget } from "../dom";

export type CanvasHandle = {
  zoomBy(factor: number): void;
  resetView(): void;
};

type CanvasProps = {
  engine: PageEngine;
  /** Called when a pen, mouse or finger starts any gesture on the page (e.g. to barge in). */
  onPenDown?: () => void;
};

export const NotebookCanvas = forwardRef<CanvasHandle, CanvasProps>(function NotebookCanvas(
  { engine, onPenDown },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const controls = useRef<CanvasHandle | null>(null);
  const penDown = useRef(onPenDown);
  useEffect(() => {
    penDown.current = onPenDown;
  }, [onPenDown]);

  useImperativeHandle(ref, () => ({
    zoomBy: (factor) => controls.current?.zoomBy(factor),
    resetView: () => controls.current?.resetView(),
  }));

  useEffect(() => {
    const container = containerRef.current;
    const [grid, ink, live] = [gridRef.current, inkRef.current, liveRef.current];
    if (!container || !grid || !ink || !live) return;

    const renderer = new CanvasRenderer({ grid, ink, live }, readTheme());
    const overlay: Overlay = { draft: null, eraser: null, lasso: null, selection: null };
    let camera: Camera = DEFAULT_CAMERA;

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
        // Selected strokes are drawn on the live layer (so they can be dragged), not here.
        const selected = new Set(overlay.selection?.strokes.map((s) => s.id));
        const visible = engine.doc.inRegion(renderer.visible(camera));
        const lines = useNotebookUi.getState().showLines ? studentLines(engine.doc) : undefined;
        renderer.drawInk(
          camera,
          selected.size ? visible.filter((s) => !selected.has(s.id)) : visible,
          lines,
        );
      }
      if (dirty.live) renderer.drawLive(camera, overlay);
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

    // --- Tools.
    const ctx: ToolContext = { engine, overlay, zoom: () => camera.zoom, invalidate: schedule };
    const tools: Record<Tool, ToolController> = {
      pen: new PenTool(ctx),
      highlighter: new PenTool(ctx),
      eraser: new EraserTool(ctx),
      lasso: new LassoTool(ctx),
    };
    const currentTool = () => tools[useNotebookUi.getState().tool];
    let gesture: ToolController | null = null;

    const toPage = (s: Sample): PagePoint => {
      const [x, y] = screenToPage(camera, [s.x, s.y]);
      return { x, y, pressure: s.pressure, time: s.time };
    };

    const input = new PointerInput(live, {
      onStrokeStart(sample) {
        penDown.current?.();
        gesture = currentTool();
        gesture.begin(toPage(sample));
      },
      onStrokeMove: (samples) => gesture?.move(samples.map(toPage)),
      onStrokeEnd() {
        gesture?.end();
        gesture = null;
      },
      onStrokeCancel() {
        gesture?.cancel();
        gesture = null;
      },
      onPan: (dx, dy) => setCamera(panBy(camera, dx, dy)),
      onZoom: (x, y, factor) => setCamera(zoomAt(camera, [x, y], factor)),
      onHover: (sample) => currentTool().hover?.(sample ? toPage(sample) : null),
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (currentTool().key?.(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);

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

    const unsubscribeEngine = engine.subscribe(() => {
      for (const tool of Object.values(tools)) tool.documentChanged?.();
      schedule({ ink: true, live: true });
    });
    const unsubscribeUi = useNotebookUi.subscribe((state, previous) => {
      if (state.showLines !== previous.showLines) schedule({ ink: true });
      if (state.tool !== previous.tool) tools[previous.tool].deactivate?.();
    });

    return () => {
      cancelAnimationFrame(frame);
      input.dispose();
      window.removeEventListener("keydown", onKeyDown);
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
});

function readTheme(): Theme {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  return {
    dark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    dot: token("--dot", "#cfc9bb"),
    tutor: token("--tutor", "#8a7bf0"),
    accent: token("--accent", "#5b8def"),
  };
}
