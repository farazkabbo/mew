export * from "./png";
export * from "./prepare";
export * from "./raster";

import { type Deflate, encodePng } from "./png";
import { type InkLike, prepareLine } from "./prepare";
import { rasterize } from "./raster";

/** The image recognition reads (K10 §8.2): a prepared line as a PNG, or null with no ink. */
export async function recognitionPng(
  strokes: readonly InkLike[],
  deflate: Deflate,
): Promise<{ png: Uint8Array; width: number; height: number } | null> {
  const line = prepareLine(strokes);
  if (!line) return null;
  const png = await encodePng(rasterize(line), deflate);
  return { png, width: line.width, height: line.height };
}
