import type { BBox } from "@mew/shared";

import type { Vec } from "./geometry";

/** Page coordinate shown at the viewport's top-left corner, and pixels per page unit. */
export type Camera = { x: number; y: number; zoom: number };

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

export function screenToPage(camera: Camera, [sx, sy]: Vec): [number, number] {
  return [sx / camera.zoom + camera.x, sy / camera.zoom + camera.y];
}

export function pageToScreen(camera: Camera, [px, py]: Vec): [number, number] {
  return [(px - camera.x) * camera.zoom, (py - camera.y) * camera.zoom];
}

/** Pan by a screen-space delta (dragging content right moves the camera left). */
export function panBy(camera: Camera, dx: number, dy: number): Camera {
  return { ...camera, x: camera.x - dx / camera.zoom, y: camera.y - dy / camera.zoom };
}

/** Zoom by `factor`, keeping the page point under `anchor` (screen space) fixed. */
export function zoomAt(camera: Camera, anchor: Vec, factor: number): Camera {
  const zoom = clamp(camera.zoom * factor, MIN_ZOOM, MAX_ZOOM);
  const [px, py] = screenToPage(camera, anchor);
  return { zoom, x: px - anchor[0] / zoom, y: py - anchor[1] / zoom };
}

/** The page region visible in a viewport of the given CSS size. */
export function visibleRegion(camera: Camera, width: number, height: number): BBox {
  return [camera.x, camera.y, width / camera.zoom, height / camera.zoom];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
