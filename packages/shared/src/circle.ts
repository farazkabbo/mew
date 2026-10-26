import { z } from "zod";

import { DestinationResolution } from "./destinations";
import { CheckQuestion, FilingNote } from "./moments";
import { Subject } from "./tutor";
import {
  AppName,
  type ScreenBox,
  ScreenBox as Box,
  ScreenImage,
  ScreenPoint,
  SCREEN_LIMITS,
  type TutorScreenAction,
  TutorScreenAction as Action,
} from "./screen";

/**
 * Circle & Ask (Screen Coach S3.2, docs/SCREEN_COACH_S3_2.md and decision 11): the student marks
 * something on their screen (a circle, an underline, an arrow, a tap) and asks about it; the tutor
 * explains it in a few steps, drawing on it as it goes, and the whole thing is saved to the
 * notebook as an entry.
 *
 * Coordinates are 0–1000 across the **focus image**: the crop around the marks the model sees
 * (the marks' bounding box plus 15 %), never the whole screen.
 */
export const CIRCLE_LIMITS = {
  marks: 3,
  polygonPoints: 48,
  markTextChars: 1_000,
  /** OCR blocks around the marks given as context. */
  blocks: 40,
  blockChars: 400,
  questionChars: 500,
  minSteps: 2,
  maxSteps: 5,
  sayWords: 25,
  sayChars: 220,
  noteWords: 6,
  summaryChars: 320,
  followUpChars: 220,
  conceptHints: 5,
  conceptChars: 80,
  /** Ink may reach this far outside the marks (brief §3.6), in screen pixels. */
  marginPx: 120,
  /** Earlier turns of the same session given to a follow-up. */
  history: 3,
  titleChars: 200,
  /** A handwritten question's crop (base64; ~300 KB). */
  questionImageChars: 400_000,
} as const;

const PlainText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), {
      message: "control characters aren't allowed",
    });

export const MarkKind = z.enum(["circle", "underline", "arrow", "tap", "loose"]);
export type MarkKind = z.infer<typeof MarkKind>;

/** One of the student's marks, as the desktop app understood it (brief §3.3). */
export const CircleMark = z.object({
  /** 1–3: how the student refers to it ("how is 1 different from 2?"). */
  number: z.number().int().min(1).max(CIRCLE_LIMITS.marks),
  kind: MarkKind,
  box: Box,
  /** The path, thinned (circles and loose marks; empty for taps). */
  polygon: z.array(ScreenPoint).max(CIRCLE_LIMITS.polygonPoints),
  /** The words it's about, read on the device after redaction (may be empty: a figure). */
  text: PlainText(CIRCLE_LIMITS.markTextChars),
});
export type CircleMark = z.infer<typeof CircleMark>;

/** How the student asked (brief §3.5). */
export const CircleAskQuestion = z.discriminatedUnion("source", [
  z.object({ source: z.literal("voice"), text: PlainText(CIRCLE_LIMITS.questionChars).min(1) }),
  z.object({ source: z.literal("typed"), text: PlainText(CIRCLE_LIMITS.questionChars).min(1) }),
  z.object({
    source: z.literal("screen_selection"),
    text: PlainText(CIRCLE_LIMITS.questionChars).min(1),
    handwritten: z.boolean(),
    confidence: z.number().min(0).max(1),
  }),
  /** Enter: "explain this". */
  z.object({ source: z.literal("none") }),
]);
export type CircleAskQuestion = z.infer<typeof CircleAskQuestion>;

/** The words of a question, or null for "explain this". */
export function questionText(question: CircleAskQuestion): string | null {
  return question.source === "none" ? null : question.text;
}

export const ContentKind = z.enum(["browser", "pdf", "video", "app"]);
export type ContentKind = z.infer<typeof ContentKind>;

/** `POST /api/screen/circle-ask`, from the desktop app (device token). */
export const CircleAskRequest = z.object({
  /** One circle-and-ask session: its follow-ups share it, and its notebook entry. */
  sessionId: z.uuid(),
  question: CircleAskQuestion,
  marks: z.array(CircleMark).min(1).max(CIRCLE_LIMITS.marks),
  /** The marked area with the student's marks drawn on (numbered), and its size on screen. */
  focus: z.object({
    image: ScreenImage,
    /** Screen pixels the focus image covers (to keep the ink within 120 px of the marks). */
    widthPx: z.number().int().min(1).max(20_000),
    heightPx: z.number().int().min(1).max(20_000),
  }),
  /** The window around it, downscaled, without marks. */
  context: ScreenImage,
  /** Text near the marks, read on the device after redaction, with boxes on the focus image. */
  blocks: z
    .array(
      z.object({
        id: z.string().regex(/^b\d{1,3}$/),
        text: PlainText(CIRCLE_LIMITS.blockChars).min(1),
        box: Box,
      }),
    )
    .max(CIRCLE_LIMITS.blocks),
  app: AppName.nullable(),
  kind: ContentKind,
  /** The page's title and link: only when "Include source link" is on. */
  source: z
    .object({
      title: PlainText(CIRCLE_LIMITS.titleChars).min(1).optional(),
      url: z
        .url({ protocol: /^https$/ })
        .max(2000)
        .optional(),
    })
    .optional(),
  /** Earlier turns of this session (a follow-up). */
  history: z
    .array(
      z.object({
        question: PlainText(CIRCLE_LIMITS.questionChars),
        summary: PlainText(CIRCLE_LIMITS.summaryChars),
      }),
    )
    .max(CIRCLE_LIMITS.history),
});
export type CircleAskRequest = z.infer<typeof CircleAskRequest>;

/** One step as the model writes it: show (its ink), then tell (`say`). */
export const CircleModelStep = z.object({
  /** Ink first: drawn before the words (actions come first so they stream first). */
  actions: z.array(Action).max(SCREEN_LIMITS.actions),
  /** Cut to 25 words by `checkedStep`: a wordy step is shortened, never dropped. */
  say: PlainText(600).min(1),
});

/** What the circle-ask model returns (prompt `circle-ask`). */
export const CircleAskModelResponse = z.object({
  /** The question as understood ("Explain this" when there was none). */
  readQuestion: PlainText(CIRCLE_LIMITS.questionChars).min(1),
  steps: z.array(CircleModelStep).max(8),
  summary: PlainText(CIRCLE_LIMITS.summaryChars).min(1),
  followUpQuestion: PlainText(CIRCLE_LIMITS.followUpChars).nullable(),
  conceptHints: z.array(PlainText(CIRCLE_LIMITS.conceptChars).min(1)).max(8),
  /** K8: what it's about, and one question to check the idea later (filed and quizzed). */
  subject: Subject,
  checkQuestion: CheckQuestion.nullable(),
});
export type CircleAskModelResponse = z.infer<typeof CircleAskModelResponse>;
export type CircleModelStep = z.infer<typeof CircleModelStep>;

/** A step as the desktop app plays it (validated, safe). */
export const CircleStep = z.object({
  index: z
    .number()
    .int()
    .min(0)
    .max(CIRCLE_LIMITS.maxSteps - 1),
  say: z.string().min(1).max(CIRCLE_LIMITS.sayChars),
  actions: z.array(Action).max(SCREEN_LIMITS.actions),
});
export type CircleStep = z.infer<typeof CircleStep>;

/** Newline-delimited JSON events streamed by `POST /api/screen/circle-ask`. */
export const CircleStreamEvent = z.discriminatedUnion("type", [
  /**
   * Where the student said to save this (K3), taken out of the question before the model saw
   * it, or the source's sticky place: first, so the card shows "Saving to: …" at once.
   */
  z.object({
    type: z.literal("destination"),
    phrase: z.string().max(160).nullable(),
    resolution: DestinationResolution,
    /** K8: the server filed it itself (nothing was said): why, and what else to offer. */
    filing: FilingNote.optional(),
  }),
  /** A step, as soon as it's complete and checked. */
  z.object({ type: z.literal("step"), step: CircleStep, latencyMs: z.number() }),
  /** Everything else, once the answer is complete. */
  z.object({
    type: z.literal("done"),
    turnId: z.uuid(),
    readQuestion: z.string().min(1).max(CIRCLE_LIMITS.questionChars),
    summary: z.string().min(1).max(CIRCLE_LIMITS.summaryChars),
    followUpQuestion: z.string().max(CIRCLE_LIMITS.followUpChars).nullable(),
    conceptHints: z
      .array(z.string().max(CIRCLE_LIMITS.conceptChars))
      .max(CIRCLE_LIMITS.conceptHints),
    latencyMs: z.number(),
  }),
  /** A step broke the safety check: stop, take back what was drawn, and say this instead. */
  z.object({ type: z.literal("abort"), speech: z.string().min(1).max(SCREEN_LIMITS.speechChars) }),
  z.object({ type: z.literal("error"), message: z.string().max(300) }),
]);
export type CircleStreamEvent = z.infer<typeof CircleStreamEvent>;

// ─── Reading a question from the screen ──────────────────────────────────────────────────────

/** `POST /api/screen/read-question`: a handwritten question, cropped on the device. */
export const ReadQuestionRequest = z.object({
  image: z.object({
    jpeg: z.string().min(1).max(CIRCLE_LIMITS.questionImageChars),
    width: z.number().int().min(1).max(SCREEN_LIMITS.imagePixelsPerSide),
    height: z.number().int().min(1).max(SCREEN_LIMITS.imagePixelsPerSide),
  }),
});
export type ReadQuestionRequest = z.infer<typeof ReadQuestionRequest>;

/** What was read: every question found (several → the student picks one), and how sure. */
export const ReadQuestionResponse = z.object({
  questions: z.array(PlainText(CIRCLE_LIMITS.questionChars).min(1)).max(5),
  handwritten: z.boolean(),
  confidence: z.number().min(0).max(1),
});
export type ReadQuestionResponse = z.infer<typeof ReadQuestionResponse>;

// ─── Checking the model's steps (code, not prompt: brief §3.6) ───────────────────────────────

/** The box around every mark (focus-image coordinates). */
export function marksBox(marks: readonly Pick<CircleMark, "box">[]): ScreenBox {
  return marks
    .map((m) => m.box)
    .reduce((a, b) => ({
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    }));
}

/** The boxes and points an action draws at (focus_region and clear draw nothing). */
function actionBoxes(action: TutorScreenAction): ScreenBox[] {
  switch (action.type) {
    case "circle_region":
    case "underline":
    case "highlight":
      return [action.box];
    case "margin_note":
    case "write_step":
      return [action.besideBox];
    case "sketch": {
      // The card goes in free space outside the marks; what it's beside and points at is checked.
      if (!action.pointTo) return [action.besideBox];
      const { x, y } = action.pointTo;
      return [action.besideBox, { left: x, top: y, right: x, bottom: y }];
    }
    case "point_at": {
      const { x, y } = action.point;
      return [{ left: x, top: y, right: x, bottom: y }];
    }
    case "focus_region":
    case "clear":
      return [];
  }
}

const words = (text: string) => text.split(/\s+/).filter(Boolean);

/**
 * A model step made playable: actions that reach more than `marginPx` outside the marks are
 * dropped, as are margin notes over 6 words and anything but drawing actions; the words are cut
 * to 25 (at a word, with "…").
 */
export function checkedStep(
  step: CircleModelStep,
  index: number,
  limits: { marks: ScreenBox; widthPx: number; heightPx: number },
): CircleStep {
  const mx = (CIRCLE_LIMITS.marginPx / limits.widthPx) * 1000;
  const my = (CIRCLE_LIMITS.marginPx / limits.heightPx) * 1000;
  const near = (box: ScreenBox) =>
    box.left >= limits.marks.left - mx &&
    box.right <= limits.marks.right + mx &&
    box.top >= limits.marks.top - my &&
    box.bottom <= limits.marks.bottom + my;
  const actions = step.actions.filter((action) => {
    if (action.type === "focus_region" || action.type === "clear") return false;
    if (action.type === "margin_note" && words(action.text).length > CIRCLE_LIMITS.noteWords) {
      return false;
    }
    return actionBoxes(action).every(near);
  });
  const say = clipWords(step.say, CIRCLE_LIMITS.sayWords).slice(0, CIRCLE_LIMITS.sayChars);
  return { index, say, actions };
}

/** At most `max` words, ending "…" when cut. */
export function clipWords(text: string, max: number): string {
  const all = words(text);
  if (all.length <= max) return all.join(" ");
  return `${all
    .slice(0, max)
    .join(" ")
    .replace(/[,;:.!?]+$/, "")}…`;
}
