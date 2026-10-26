"use client";

import { type Camera, DEFAULT_CAMERA } from "@mew/ink";
import { type RefObject, useEffect, useRef } from "react";

import type { CanvasHandle } from "../notebook/canvas/NotebookCanvas";
import type { TutorInk } from "./ink";

/** How long the pointer takes to glide to where the ink starts (the ink waits for it). */
export const POINTER_GLIDE_MS = 240;

/** The ink's lead-in: time to glide there, or none with reduced motion (it just appears). */
export function pointerLeadIn(): number {
  const reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduced ? 0 : POINTER_GLIDE_MS;
}

/** The pen tip in the pointer's 32 × 32 drawing (the same Mew mark as the desktop's pointer). */
const TIP: readonly [number, number] = [20, 29];
const SIZE = 32;
/** Where it rests: just left of the mascot, bottom right (CSS px from the corner). */
const DOCK: readonly [number, number] = [88, 28];

/** Where the pointer's top-left goes (CSS px in the canvas) so its pen tip is on `tip`. */
export function pointerAt(tip: readonly [number, number], camera: Camera): [number, number] {
  return [(tip[0] - camera.x) * camera.zoom - TIP[0], (tip[1] - camera.y) * camera.zoom - TIP[1]];
}

type Props = {
  canvas: RefObject<CanvasHandle | null>;
  ink: Pick<TutorInk, "tip" | "subscribe">;
};

/**
 * The tutor pointer in the notebook (K6 §6.3): it rests by the mascot and, whenever the tutor
 * writes, glides to the spot first so the ink comes out of its pen and the student's eyes
 * follow the work. With reduced motion it doesn't glide; it's just there. Never takes the pen.
 */
export function NotebookPointer({ canvas, ink }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const pointer = useRef<SVGSVGElement>(null);

  useEffect(() => {
    let camera = DEFAULT_CAMERA;
    let writing = false;
    const place = () => {
      const el = pointer.current;
      const box = root.current;
      if (!el || !box) return;
      const tip = ink.tip();
      let at: [number, number];
      if (tip) {
        at = pointerAt(tip, camera);
        // The first move glides there; after that it follows the pen closely.
        el.style.transitionDuration = writing ? "70ms" : `${POINTER_GLIDE_MS}ms`;
        el.style.transitionTimingFunction = writing ? "linear" : "ease-out";
        writing = true;
      } else {
        at = [box.clientWidth - DOCK[0] - SIZE, box.clientHeight - DOCK[1] - SIZE];
        el.style.transitionDuration = "";
        el.style.transitionTimingFunction = "";
        writing = false;
      }
      el.dataset.look = writing ? "writing" : "resting";
      el.style.transform = `translate(${at[0]}px, ${at[1]}px)`;
    };
    const stopCamera = canvas.current?.onCamera((next) => {
      camera = next;
      place();
    });
    const stopInk = ink.subscribe(place);
    window.addEventListener("resize", place);
    place();
    return () => {
      stopCamera?.();
      stopInk();
      window.removeEventListener("resize", place);
    };
  }, [canvas, ink]);

  return (
    <div ref={root} className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <svg
        ref={pointer}
        data-testid="notebook-pointer"
        data-look="resting"
        viewBox="0 0 32 32"
        width={SIZE}
        height={SIZE}
        className="group absolute top-0 left-0 text-tutor opacity-50 transition-[transform,opacity] duration-500 ease-out data-[look=writing]:opacity-100 motion-reduce:transition-none"
      >
        <path fill="currentColor" d="M8 12 L10 5 L14 10 Z M24 12 L22 5 L18 10 Z" />
        <circle fill="currentColor" cx="16" cy="17" r="9" />
        <path
          className="fill-ink opacity-0 group-data-[look=writing]:opacity-100"
          d="M21 25 L28 18 L30 20 L23 27 Z M21 25 L20 29 L23 27 Z"
        />
      </svg>
    </div>
  );
}
