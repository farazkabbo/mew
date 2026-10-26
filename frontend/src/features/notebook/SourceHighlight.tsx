"use client";

import type { ImageBlock } from "@mew/shared";
import { type RefObject, useEffect, useRef } from "react";

import type { CanvasHandle } from "./canvas/NotebookCanvas";
import { TUTOR_HIGHLIGHT } from "./palette";
import { useNotebookUi } from "./store";

/** How long the circled words stay highlighted. */
const HIGHLIGHT_MS = 8000;
/** Page units shown above the first highlighted line. */
const LEAD = 80;
/** Page units around each highlighted line. */
const PAD = 3;

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  /** The page's images: the highlight is on one of its PDF pages. */
  images: readonly ImageBlock[];
};

/**
 * A moment opened on its PDF page in neb (K8 §4.7): the words it circled on screen are
 * highlighted on the page for a few seconds, scrolled into view. A layer that follows the camera,
 * like the entries' notes; it never takes the pointer, so writing on the page goes on.
 */
export function SourceHighlight({ canvas, images }: Props) {
  const layer = useRef<HTMLDivElement>(null);
  const highlight = useNotebookUi((s) => s.sourceHighlight);
  const image = highlight ? images.find((i) => i.id === highlight.imageId) : undefined;
  const firstTop =
    image && highlight?.boxes.length
      ? image.y + Math.min(...highlight.boxes.map((b) => b[1])) * image.height
      : null;

  useEffect(() => {
    return canvas.current?.onCamera(({ x, y, zoom }) => {
      if (layer.current)
        layer.current.style.transform = `scale(${zoom}) translate(${-x}px, ${-y}px)`;
    });
  }, [canvas]);

  useEffect(() => {
    if (!highlight || firstTop === null) return;
    canvas.current?.showTop(firstTop - LEAD);
    const timer = setTimeout(() => useNotebookUi.getState().highlightSource(null), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlight, firstTop, canvas]);

  // The layer is always there, so it follows the camera from the start.
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div ref={layer} className="absolute top-0 left-0 origin-top-left">
        {image &&
          highlight?.boxes.map(([left, top, right, bottom], i) => (
            <div
              key={i}
              data-testid="source-highlight"
              className="absolute rounded-sm mix-blend-multiply motion-safe:animate-pulse"
              style={{
                left: image.x + left * image.width - PAD,
                top: image.y + top * image.height - PAD,
                width: (right - left) * image.width + 2 * PAD,
                height: (bottom - top) * image.height + 2 * PAD,
                backgroundColor: TUTOR_HIGHLIGHT.light,
              }}
            />
          ))}
      </div>
    </div>
  );
}
