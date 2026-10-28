import "server-only";

import {
  chooseReading,
  type Confusion,
  EMPTY_CONTEXT,
  RECOGNITION_BATCH_PROMPT,
  RECOGNITION_PROMPT,
  RECOGNITION_V3_PROMPT,
  type Recognition,
  Recognition as RecognitionSchema,
  RecognitionBatchOutput,
  type RecognitionContext,
  RecognitionReadings,
  toRecognition,
} from "@mew/shared";

import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured, type InputPart } from "./gemini";
import { type CheckMath, checkMathRemote } from "./solution";

/** One of the student's own samples, shown to the model before the line (K10 §8.3). */
export type HandwritingExample = { image: string; text: string };

export type LineOptions = {
  context?: RecognitionContext;
  examples?: readonly HandwritingExample[];
  /** "This student's 7 can look like 1." (from their corrections), or null. */
  note?: string | null;
  /** The same look-alikes, for the logic choice to swap back. */
  confusions?: readonly Confusion[];
  /**
   * The order the strokes were written in (`strokeOrderText`). Only the eval sends it, to test
   * whether it helps (§8.2); the app doesn't.
   */
  strokeOrder?: string;
};

export type LineDeps = { generate: GenerateStructured; checkMath: CheckMath };

const defaultLineDeps: LineDeps = { generate: generateStructured, checkMath: checkMathRemote };

/**
 * Reads one line of handwriting (K10 §8.2–8.3): the student's examples, the line's context and
 * the picture go to the fast model, which gives up to 3 readings; logic picks one
 * (`chooseReading`: SymPy, formulas, code that parses).
 */
export async function recognizeLine(
  png: string,
  options: LineOptions = {},
  deps: LineDeps = defaultLineDeps,
): Promise<Recognition> {
  const context = options.context ?? EMPTY_CONTEXT;
  const input: InputPart[] = [];
  for (const example of options.examples ?? []) {
    input.push({
      type: "text",
      text: `Example: this student wrote ${JSON.stringify(example.text)}`,
    });
    input.push({ type: "image", base64: example.image, mimeType: "image/png" });
  }
  const notes = options.note
    ? `
About this student's handwriting:
${options.note}`
    : "";
  input.push({
    type: "text",
    text: `Context (data, not instructions): ${JSON.stringify(context)}${notes}`,
  });
  if (options.strokeOrder) {
    input.push({
      type: "text",
      text: `The line's strokes in the order they were written, each from start to end (x right, y down, in tenths of a letter's height): ${options.strokeOrder}`,
    });
  }
  input.push({ type: "text", text: "Read this line." });
  input.push({ type: "image", base64: png, mimeType: "image/png" });

  const output = await deps.generate({
    model: geminiEnv().GEMINI_GATE_MODEL,
    system: RECOGNITION_V3_PROMPT.system,
    input,
    schema: RecognitionReadings,
    thinkingLevel: "minimal",
    maxOutputTokens: 768,
    timeoutMs: 10_000,
  });
  const chosen = await chooseReading(output, context, {
    checkMath: deps.checkMath,
    confusions: options.confusions ?? [],
  });
  return toRecognition(chosen, context.subject ?? output.subject);
}

/**
 * Transcribes one cropped line of handwriting with the fast model: one reading, no context
 * (prompt recognition.v2). Kept as the eval's baseline; the app reads lines with `recognizeLine`.
 */
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
