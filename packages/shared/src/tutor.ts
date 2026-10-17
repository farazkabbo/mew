import { z } from "zod";

import { MEW_LIMITS, MewLabel } from "./mew";

export const TUTOR_LIMITS = {
  speechChars: 400,
  boardTextChars: 120,
  actions: 6,
  /** Base64 PNG of the student's recent work (~1.1 MB decoded). */
  imageBase64Chars: 1_500_000,
  imagePixelsPerSide: 2048,
  recognizedLines: 8,
  graphNodes: 16,
  ttsChars: 600,
} as const;

// ─── Board actions (rendered as ink from M4) ────────────────────────────────────────────────

export const Anchor = z.object({
  near: z.enum(["active_line", "below_active_line", "margin_right", "free_space"]),
});
export type Anchor = z.infer<typeof Anchor>;

const BoardText = z.string().min(1).max(TUTOR_LIMITS.boardTextChars);
const Latex = z.string().min(1).max(TUTOR_LIMITS.boardTextChars);

/** Shapes in a unit box (0–1) that the renderer scales into the anchored area. */
export const Shape = z.object({
  kind: z.enum(["line", "arrow", "box", "circle"]),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
  label: z.string().max(40).optional(),
});
export type Shape = z.infer<typeof Shape>;

export const BoardAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write_text"), text: BoardText, anchor: Anchor }),
  z.object({ type: z.literal("write_math"), latex: Latex, anchor: Anchor }),
  z.object({ type: z.literal("mark_error"), targetLineId: z.string().max(80), note: BoardText }),
  z.object({ type: z.literal("mark_correct"), targetLineId: z.string().max(80) }),
  z.object({
    type: z.literal("complete_step"),
    latex: Latex.optional(),
    text: BoardText.optional(),
    anchor: Anchor,
  }),
  z.object({
    type: z.literal("draw_plot"),
    expressions: z.array(z.string().min(1).max(80)).min(1).max(4),
    xRange: z.tuple([z.number(), z.number()]),
    yRange: z.tuple([z.number(), z.number()]).optional(),
    anchor: Anchor,
  }),
  z.object({
    type: z.literal("draw_graph"),
    kind: z.enum(["mindmap", "flowchart"]),
    nodes: z
      .array(z.object({ id: z.string().max(24), label: z.string().min(1).max(40) }))
      .min(1)
      .max(TUTOR_LIMITS.graphNodes),
    edges: z
      .array(
        z.object({
          from: z.string().max(24),
          to: z.string().max(24),
          label: z.string().max(30).optional(),
        }),
      )
      .max(TUTOR_LIMITS.graphNodes * 2),
    anchor: Anchor,
  }),
  z.object({
    type: z.literal("draw_shapes"),
    shapes: z.array(Shape).min(1).max(12),
    anchor: Anchor,
  }),
]);
export type BoardAction = z.infer<typeof BoardAction>;

/** What the tutor model returns. `speech` comes first so it can be spoken before the rest arrives. */
export const TutorResponse = z.object({
  speech: z.string().min(1).max(TUTOR_LIMITS.speechChars),
  actions: z.array(BoardAction).max(TUTOR_LIMITS.actions),
});
export type TutorResponse = z.infer<typeof TutorResponse>;

// ─── Requests ───────────────────────────────────────────────────────────────────────────────

export const AnswerStyle = z.enum(["hints_first", "direct"]);
export type AnswerStyle = z.infer<typeof AnswerStyle>;

export const RecognizedLine = z.object({
  lineId: z.string().max(80),
  text: z.string().max(300),
  latex: z.string().max(300).nullable(),
});
export type RecognizedLine = z.infer<typeof RecognizedLine>;

export const TutorRequest = z.object({
  /** Why the tutor is responding (the gate's label; never "ignore"). */
  intent: MewLabel.exclude(["ignore"]),
  lastUtterance: z.string().max(MEW_LIMITS.utteranceChars),
  recentTranscript: z.array(z.string().max(MEW_LIMITS.utteranceChars)).max(10),
  /** PNG (base64, no data: prefix) of the student's recent work, if any. */
  pageImage: z.string().max(TUTOR_LIMITS.imageBase64Chars).nullable(),
  recognizedLines: z.array(RecognizedLine).max(TUTOR_LIMITS.recognizedLines),
  answerStyle: AnswerStyle,
  depth: z.enum(["normal", "deep"]),
  /** What the tutor said in the last turns (for continuity). */
  previousTutorSpeech: z.array(z.string().max(TUTOR_LIMITS.speechChars)).max(3),
});
export type TutorRequest = z.infer<typeof TutorRequest>;

/** Newline-delimited JSON events streamed by `POST /api/tutor`. */
export const TutorStreamEvent = z.discriminatedUnion("type", [
  /** The spoken reply, sent as soon as it's complete (before board actions). */
  z.object({ type: z.literal("speech"), text: z.string(), latencyMs: z.number() }),
  /** The full validated response. */
  z.object({ type: z.literal("response"), response: TutorResponse, latencyMs: z.number() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type TutorStreamEvent = z.infer<typeof TutorStreamEvent>;

export const RecognizeRequest = z.object({
  image: z.string().min(1).max(TUTOR_LIMITS.imageBase64Chars),
});
export type RecognizeRequest = z.infer<typeof RecognizeRequest>;

export const Subject = z.enum([
  "math",
  "physics",
  "chemistry",
  "biology",
  "history",
  "language",
  "programming",
  "other",
]);
export type Subject = z.infer<typeof Subject>;

/** Handwriting recognition of one cropped line. */
export const Recognition = z.object({
  text: z.string().max(300),
  latex: z.string().max(300).nullable(),
  subject: Subject,
});
export type Recognition = z.infer<typeof Recognition>;

export const TtsRequest = z.object({ text: z.string().min(1).max(TUTOR_LIMITS.ttsChars) });
export type TtsRequest = z.infer<typeof TtsRequest>;

/** Raw audio format streamed by `POST /api/tts`: signed 16-bit little-endian mono PCM. */
export const TTS_SAMPLE_RATE = 24_000;
