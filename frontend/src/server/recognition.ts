import "server-only";

import {
  RECOGNITION_BATCH_PROMPT,
  RECOGNITION_PROMPT,
  type Recognition,
  Recognition as RecognitionSchema,
  RecognitionBatchOutput,
} from "@mew/shared";

import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured, type InputPart } from "./gemini";

/** Transcribes one cropped line of handwriting with the fast model. */
export async function recognizeHandwriting(
  png: string,
  generate: GenerateStructured = generateStructured,
): Promise<Recognition> {
  const recognition = await generate({
    model: geminiEnv().GEMINI_GATE_MODEL,
    system: RECOGNITION_PROMPT.system,
    input: [
      { type: "text", text: "Transcribe this handwritten line." },
      { type: "image", base64: png, mimeType: "image/png" },
    ],
    schema: RecognitionSchema,
    thinkingLevel: "minimal",
    maxOutputTokens: 512,
    timeoutMs: 8000,
  });
  return withHonestConfidence(recognition);
}

/**
 * Transcribes several cropped lines in one call (Notes Check backfill): each image follows its
 * label, and the answer names the label of each line. Returns one result per image, in order;
 * null for a line the model left out.
 */
export async function recognizeHandwritingBatch(
  pngs: readonly string[],
  generate: GenerateStructured = generateStructured,
): Promise<(Recognition | null)[]> {
  const input: InputPart[] = [
    { type: "text", text: `Transcribe these ${pngs.length} handwritten lines.` },
  ];
  pngs.forEach((png, i) => {
    input.push({ type: "text", text: `Line ${i + 1}` });
    input.push({ type: "image", base64: png, mimeType: "image/png" });
  });
  const output = await generate({
    model: geminiEnv().GEMINI_GATE_MODEL,
    system: RECOGNITION_BATCH_PROMPT.system,
    input,
    schema: RecognitionBatchOutput,
    thinkingLevel: "minimal",
    maxOutputTokens: 256 + 256 * pngs.length,
    timeoutMs: 15_000,
  });

  const byLabel = new Map<number, Recognition>();
  for (const { line, ...recognition } of output.lines) {
    // Two answers for one label: neither can be trusted to be that line.
    if (byLabel.has(line)) byLabel.set(line, { ...recognition, confidence: 0 });
    else byLabel.set(line, recognition);
  }
  return pngs.map((_, i) => {
    const recognition = byLabel.get(i + 1);
    return recognition ? withHonestConfidence(recognition) : null;
  });
}

/** The model's confidence, except that an empty transcription is never "sure". */
export function withHonestConfidence(recognition: Recognition): Recognition {
  return recognition.text.trim() === "" ? { ...recognition, confidence: 0 } : recognition;
}
