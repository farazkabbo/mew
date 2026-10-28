import { z } from "zod";

import { CHECK_LIMITS, LineCheck } from "./check";
import { COURSE_LIMITS, CourseExcerpt } from "./course";
import { GeometrySpec, MoleculeFigure } from "./figures";
import { MEW_LIMITS, MewLabel } from "./mew";
import { QuizContext } from "./quiz";
import { Subject } from "./subject";

export const TUTOR_LIMITS = {
  speechChars: 400,
  boardTextChars: 120,
  actions: 6,
  /** Base64 PNG of the student's recent work (~1.1 MB decoded). */
  imageBase64Chars: 1_500_000,
  imagePixelsPerSide: 2048,
  /** Base64 PNG of one cropped line (at most 1024 px on its long side; mostly white). */
  lineImageBase64Chars: 300_000,
  recognizedLines: 8,
  graphNodes: 16,
  ttsChars: 600,
  /** Clips on the page whose text the tutor sees, and how much of each. */
  clippedTexts: 2,
  clippedTextChars: 4000,
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

/** Figures without a place: the notebook adds an anchor, the screen's sketch card a box. */
export const DrawPlot = z.object({
  type: z.literal("draw_plot"),
  expressions: z.array(z.string().min(1).max(80)).min(1).max(4),
  xRange: z.tuple([z.number(), z.number()]),
  yRange: z.tuple([z.number(), z.number()]).optional(),
});
export const DrawShapes = z.object({
  type: z.literal("draw_shapes"),
  shapes: z.array(Shape).min(1).max(12),
});
export const DrawGeometry = z.object({ type: z.literal("draw_geometry"), figure: GeometrySpec });
/**
 * `type` first: Gemini writes properties in schema order, so a union variant whose tag isn't its
 * first property can never be chosen once the model has written `"type"`.
 */
export const DrawMolecule = z.object({
  type: z.literal("draw_molecule"),
  ...MoleculeFigure.shape,
});

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
  DrawPlot.extend({ anchor: Anchor }),
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
  DrawShapes.extend({ anchor: Anchor }),
  /**
   * K6 §6.3: marks on the student's own lines (by `lineId` from recognizedLines), not on empty
   * space: underline it, loop round it, or point at it with a short note.
   */
  z.object({ type: z.literal("underline"), targetLineId: z.string().max(80) }),
  z.object({ type: z.literal("circle_region"), targetLineId: z.string().max(80) }),
  z.object({
    type: z.literal("point_at"),
    targetLineId: z.string().max(80),
    note: z.string().min(1).max(40).optional(),
  }),
  /** K5: a figure with rules, built by the solver (never coordinates from the model). */
  DrawGeometry.extend({ anchor: Anchor }),
  /** K5: a molecule from SMILES, laid out on the device. */
  DrawMolecule.extend({ anchor: Anchor }),
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
  /** K9: the line's open live annotation (what a verifier marked on it while it was written). */
  mark: z
    .object({
      kind: z.enum(["tick", "error", "missing", "margin", "unsure"]),
      note: z.string().max(32).nullable(),
    })
    .optional(),
});
export type RecognizedLine = z.infer<typeof RecognizedLine>;

/** Text read (on the device) from a clip on the page, and where the clip came from. */
export const ClippedText = z.object({
  source: z.string().max(200),
  text: z.string().max(TUTOR_LIMITS.clippedTextChars),
});
export type ClippedText = z.infer<typeof ClippedText>;

export const TutorRequest = z.object({
  /**
   * Why the tutor is responding (the gate's label; never "ignore", and never the notebook's own
   * commands: saving and organising are done in the notebook, K3).
   */
  intent: MewLabel.exclude(["ignore", "save_to_notebook", "notebook_command"]),
  lastUtterance: z.string().max(MEW_LIMITS.utteranceChars),
  recentTranscript: z.array(z.string().max(MEW_LIMITS.utteranceChars)).max(10),
  /** PNG (base64, no data: prefix) of the student's recent work, if any. */
  pageImage: z.string().max(TUTOR_LIMITS.imageBase64Chars).nullable(),
  recognizedLines: z.array(RecognizedLine).max(TUTOR_LIMITS.recognizedLines),
  answerStyle: AnswerStyle,
  depth: z.enum(["normal", "deep"]),
  /** What the tutor said in the last turns (for continuity). */
  previousTutorSpeech: z.array(z.string().max(TUTOR_LIMITS.speechChars)).max(3),
  /** Verified verdicts about recent lines (SymPy, chemistry balance, code runs). */
  checks: z.array(LineCheck).max(CHECK_LIMITS.checksPerTurn).default([]),
  /** Passages of the student's course material relevant to this turn (with pages to cite). */
  courseContext: z.array(CourseExcerpt).max(COURSE_LIMITS.excerptsPerTurn).default([]),
  /** The quiz question the student is answering, if a quiz is running (M8). */
  quiz: QuizContext.nullable().default(null),
  /** Text of images on the page saved from the screen (Screen Coach S3), newest first. */
  clippedText: z.array(ClippedText).max(TUTOR_LIMITS.clippedTexts).default([]),
  /**
   * The student circled `recognizedLines` while holding Ctrl+Alt (K6 §6.3): they and the image
   * are exactly what was circled, so "this" means them.
   */
  circled: z.boolean().default(false),
  /**
   * Printed text the student circled on a PDF page in neb (K4 §5.2: from its text layer, not
   * read off a picture), with its file and page: "this" means it.
   */
  circledText: ClippedText.nullable().default(null),
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

export { Subject } from "./subject";

/** Handwriting recognition of one cropped line. */
export const Recognition = z.object({
  text: z.string().max(300),
  latex: z.string().max(300).nullable(),
  subject: Subject,
  /**
   * How sure the model is that `text` is exactly what's written (its own estimate: the API has
   * no token probabilities). Notes Check treats lines under 0.6 as "can't tell".
   */
  confidence: z.number().min(0).max(1),
  /** K10: the model's other readings of the line (at most 2), most likely first. */
  alternatives: z
    .array(
      z.object({
        text: z.string().max(300),
        latex: z.string().max(300).nullable(),
        confidence: z.number().min(0).max(1),
      }),
    )
    .max(2)
    .optional(),
  /** K10: what chose this reading over the model's first (SymPy, a formula, code that parses). */
  chosenBy: z.enum(["model", "math", "chemistry", "code", "profile"]).optional(),
});
export type Recognition = z.infer<typeof Recognition>;

/** Lines recognised in one call (Notes Check backfill): fewer requests for the same work. */
export const RECOGNIZE_BATCH_MAX = 8;

/** `POST /api/recognize/batch`: cropped lines, each a PNG, recognised together. */
export const RecognizeBatchRequest = z.object({
  images: z
    .array(z.string().min(1).max(TUTOR_LIMITS.lineImageBase64Chars))
    .min(1)
    .max(RECOGNIZE_BATCH_MAX),
});
export type RecognizeBatchRequest = z.infer<typeof RecognizeBatchRequest>;

/** One result per image, in order; null when the model skipped that line. */
export const RecognizeBatchResponse = z.object({
  lines: z.array(Recognition.nullable()).max(RECOGNIZE_BATCH_MAX),
});
export type RecognizeBatchResponse = z.infer<typeof RecognizeBatchResponse>;

/** What the model returns for a batch: each line names the label of its image ("Line 3"). */
export const RecognitionBatchOutput = z.object({
  lines: z.array(Recognition.extend({ line: z.number().int().min(1) })).max(RECOGNIZE_BATCH_MAX),
});
export type RecognitionBatchOutput = z.infer<typeof RecognitionBatchOutput>;

export const TtsRequest = z.object({
  text: z.string().min(1).max(TUTOR_LIMITS.ttsChars),
  /** A voice from GET /api/voices; anything else falls back to the default voice. */
  voiceId: z
    .string()
    .regex(/^[A-Za-z0-9]{8,64}$/)
    .nullish(),
});
export type TtsRequest = z.infer<typeof TtsRequest>;

/** Raw audio format streamed by `POST /api/tts`: signed 16-bit little-endian mono PCM. */
export const TTS_SAMPLE_RATE = 24_000;
