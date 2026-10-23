"use client";

import type { BBox } from "@mew/shared";
import {
  bboxesIntersect,
  type Camera,
  DEFAULT_CAMERA,
  panBy,
  screenToPage,
  zoomAt,
} from "@mew/ink";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

import type { PageEngine } from "../engine";
import { studentLines } from "../export-line";
import type { Tool } from "../palette";
import { useNotebookUi } from "../store";
import { ClipImages } from "./clip-images";
import { PointerInput, type Sample } from "./input";
import { CanvasRenderer, type Theme } from "./renderer";
import { EraserTool } from "./tools/eraser";
import { LassoTool } from "./tools/lasso";
import { PenTool } from "./tools/pen";
import type { Overlay, PagePoint, ToolContext, ToolController } from "./tools/types";
import { isTypingTarget } from "../dom";
import type { InkLayer } from "../../tutor/ink";
import { isShown } from "../visibility";

export type CanvasHandle = {
  zoomBy(factor: number): void;
  resetView(): void;
};

type CanvasProps = {
  engine: PageEngine;
  /** Called when a pen, mouse or finger starts any gesture on the page (e.g. to barge in). */
  onPenDown?: () => void;
  /** The tutor's ink while it's being written (drawn on the live layer). */
  tutorInk?: InkLayer & { attachViewport(viewport: () => BBox): () => void };
  /** Extra screen width (CSS px) covered on the left by a floating panel (e.g. the quiz card). */
  leftInset?: number;
};

export const NotebookCanvas = forwardRef<CanvasHandle, CanvasProps>(function NotebookCanvas(
  { engine, onPenDown, tutorInk, leftInset = 0 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const inkRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const controls = useRef<CanvasHandle | null>(null);
  const penDown = useRef(onPenDown);
  const inset = useRef(leftInset);
  useEffect(() => {
    penDown.current = onPenDown;
    inset.current = leftInset;
  }, [onPenDown, leftInset]);

  useImperativeHandle(ref, () => ({
    zoomBy: (factor) => controls.current?.zoomBy(factor),
    resetView: () => controls.current?.resetView(),
  }));

  useEffect(() => {
    const container = containerRef.current;
    const [grid, ink, live] = [gridRef.current, inkRef.current, liveRef.current];
    if (!container || !grid || !ink || !live) return;

    const renderer = new CanvasRenderer({ grid, ink, live }, readTheme());
    const overlay: Overlay = {
      draft: null,
      eraser: null,
      lasso: null,
      selection: null,
      tutor: [],
    };
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
        const visible = engine.doc.inRegion(renderer.visible(camera)).filter(isShown);
        const lines = useNotebookUi.getState().showLines ? studentLines(engine.doc) : undefined;
        const region = renderer.visible(camera);
        const pictures = engine.images
          .map((image) => ({
            box: [image.x, image.y, image.width, image.height] as BBox,
            clipId: image.clipId,
          }))
          .filter(({ box }) => bboxesIntersect(box, region))
          .map(({ box, clipId }) => ({ box, bitmap: clipImages.get(clipId) }));
        renderer.drawInk(
          camera,
          selected.size ? visible.filter((s) => !selected.has(s.id)) : visible,
          lines,
          pictures,
        );
      }
      if (dirty.live) {
        overlay.tutor =
          tutorInk && useNotebookUi.getState().showTutorInk ? tutorInk.liveStrokes() : [];
        renderer.drawLive(camera, overlay);
      }
      dirty.grid = dirty.ink = dirty.live = false;
    };
    const all = { grid: true, ink: true, live: true };
    // Clips saved from the screen: their pictures load in the background, then redraw.
    const clipImages = new ClipImages(() => schedule({ ink: true }));

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
      if (state.showTutorInk !== previous.showTutorInk) schedule({ ink: true, live: true });
      if (state.tool !== previous.tool) tools[previous.tool].deactivate?.();
    });
    const unsubscribeTutor = tutorInk?.subscribe(() => schedule({ live: true }));
    const detachViewport = tutorInk?.attachViewport(() =>
      safeArea(renderer.visible(camera), camera.zoom, inset.current),
    );

    return () => {
      cancelAnimationFrame(frame);
      clipImages.dispose();
      input.dispose();
      window.removeEventListener("keydown", onKeyDown);
      resize.disconnect();
      darkQuery.removeEventListener("change", onTheme);
      unsubscribeEngine();
      unsubscribeUi();
      unsubscribeTutor?.();
      detachViewport?.();
      controls.current = null;
    };
  }, [engine, tutorInk]);

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

/** Screen margins (CSS px) covered by floating UI: the toolbar above, page nav and mascot below. */
const CHROME = { top: 80, bottom: 84, left: 16, right: 16 };

/** The part of the visible page not hidden under the floating controls, in page units. */
function safeArea([x, y, w, h]: BBox, zoom: number, leftInset: number): BBox {
  const t = CHROME.top / zoom;
  const b = CHROME.bottom / zoom;
  const l = Math.max(CHROME.left, leftInset) / zoom;
  const r = CHROME.right / zoom;
  return [x + l, y + t, Math.max(0, w - l - r), Math.max(0, h - t - b)];
}
