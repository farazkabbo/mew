import type { BBox } from "@mew/shared";

export type CropPlan = {
  /** Region of the page to capture, in page units (already padded). */
  region: BBox;
  /** Output pixels per page unit. */
  scale: number;
  pixelWidth: number;
  pixelHeight: number;
};

export type CropOptions = {
  /** Page units added on every side. */
  padding: number;
  /** Longest output side, in pixels (keeps recognition requests small). */
  maxSide: number;
  /** Upscale small regions up to this factor so thin ink stays legible. */
  maxScale: number;
};

const DEFAULTS: CropOptions = { padding: 16, maxSide: 1024, maxScale: 3 };

/** Decides what part of the page to rasterise for a crop, and at what resolution. */
export function planCrop(bbox: BBox, options: Partial<CropOptions> = {}): CropPlan {
  const { padding, maxSide, maxScale } = { ...DEFAULTS, ...options };
  const region: BBox = [
    bbox[0] - padding,
    bbox[1] - padding,
    Math.max(1, bbox[2] + 2 * padding),
    Math.max(1, bbox[3] + 2 * padding),
  ];
  const scale = Math.min(maxScale, maxSide / Math.max(region[2], region[3]));
  return {
    region,
    scale,
    pixelWidth: Math.max(1, Math.round(region[2] * scale)),
    pixelHeight: Math.max(1, Math.round(region[3] * scale)),
  };
}
