import { bytesToBase64, recognitionPng } from "@mew/ink";
import type { CALIBRATION_PROMPTS } from "@mew/shared";
import {
  HANDWRITING_LIMITS,
  type HandwritingSampleInput,
  RECOGNIZE_BATCH_MAX,
  RecognizeBatchResponse,
  type Point,
} from "@mew/shared";

import { browserDeflate } from "../tutor/deflate";

/** One calibration box's prompt and what the student wrote in it. */
export type CalibrationEntry = { prompt: (typeof CALIBRATION_PROMPTS)[number]; strokes: Point[][] };

/**
 * Turns a calibration (K10 §8.3: digits, x y z t n, symbols, one sentence) into samples. Each box
 * is read first, the same way a notebook line is, so what neb gets wrong straight away shows up
 * as a look-alike ("your 7 reads as 1") from the start. A box that can't be read is still kept,
 * with no reading.
 */
export async function calibrationSamples(
  entries: readonly CalibrationEntry[],
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<HandwritingSampleInput[]> {
  const written = entries.filter((e) => e.strokes.some((s) => s.length > 0));
  const images = await Promise.all(
    written.map(async (e) => {
      const made = await recognitionPng(
        e.strokes.map((points) => ({ points })),
        browserDeflate,
      );
      return made ? bytesToBase64(made.png) : null;
    }),
  );
  const usable = written
    .map((entry, i) => ({ entry, image: images[i] ?? null }))
    .filter(
      (u): u is { entry: CalibrationEntry; image: string } =>
        !!u.image && u.image.length <= HANDWRITING_LIMITS.sampleImageChars,
    );

  const readings: (string | null)[] = [];
  for (let i = 0; i < usable.length; i += RECOGNIZE_BATCH_MAX) {
    const batch = usable.slice(i, i + RECOGNIZE_BATCH_MAX);
    try {
      const response = await fetchImpl("/api/recognize/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ images: batch.map((u) => u.image) }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const { lines } = RecognizeBatchResponse.parse(await response.json());
      batch.forEach((_, j) => readings.push(lines[j]?.text.trim() || null));
    } catch {
      batch.forEach(() => readings.push(null));
    }
  }

  return usable.map(({ entry, image }, i) => {
    const read = readings[i] ?? null;
    return {
      id: crypto.randomUUID(),
      text: entry.prompt.text,
      latex: entry.prompt.latex,
      readAs: read && !sameMark(read, entry.prompt.text) ? read.slice(0, 300) : null,
      source: "calibration" as const,
      image,
    };
  });
}

/** "−" read as "-", "×" as "x" when the prompt is a symbol, etc. count as read right. */
function sameMark(read: string, meant: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/[−–—]/g, "-")
      .replace(/\\times/g, "×")
      .replace(/\\div/g, "÷")
      .replace(/\s+/g, " ")
      .toLowerCase();
  return norm(read) === norm(meant);
}
