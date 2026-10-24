import { z } from "zod";

/**
 * Screen Coach (docs/SCREEN_COACH.md): what the desktop app sends when the student asks about
 * their screen, and what the tutor answers.
 *
 * Coordinates are normalised to 0–1000 across the screenshot (brief §4.2), so they don't depend
 * on its pixel size. Points and boxes are objects rather than the brief's tuples: Gemini's
 * schema subset can't describe tuple items, and named fields are clearer anyway.
 */
export const SCREEN_LIMITS = {
  /** What the tutor says: 1–2 short sentences. */
  speechChars: 300,
  labelChars: 40,
  /** A margin note: a few words. */
  noteChars: 80,
  /** A written step: one short equation or line. */
  stepChars: 120,
  actions: 8,
  transcriptChars: 500,
  /** Base64 of the JPEG (~1 MB decoded); the desktop app sends ~150–300 KB. */
  imageBase64Chars: 1_400_000,
  imagePixelsPerSide: 2048,
  /** Longest video the timestamp may point into (a day: lectures, streams). */
  videoSeconds: 86_400,
} as const;

/** 0–1000 across the screenshot (0 = left/top edge, 1000 = right/bottom edge). */
const Coordinate = z.number().int().min(0).max(1000);

export const ScreenPoint = z.object({ x: Coordinate, y: Coordinate });
export type ScreenPoint = z.infer<typeof ScreenPoint>;

export const ScreenBox = z
  .object({ left: Coordinate, top: Coordinate, right: Coordinate, bottom: Coordinate })
  .refine((b) => b.left <= b.right && b.top <= b.bottom, "box edges are out of order");
export type ScreenBox = z.infer<typeof ScreenBox>;

const Label = z.string().min(1).max(SCREEN_LIMITS.labelChars);

/** What the focus region holds (videos get their notes outside the player). */
export const FocusKind = z.enum(["question", "figure", "video_frame", "code", "text"]);
export type FocusKind = z.infer<typeof FocusKind>;

/** Where a note goes relative to the box it's about ("auto": right, then left, then below). */
export const NoteSide = z.enum(["left", "right", "below", "auto"]);
export type NoteSide = z.infer<typeof NoteSide>;

const FocusRegion = z.object({ type: z.literal("focus_region"), box: ScreenBox, kind: FocusKind });
const CircleRegion = z.object({
  type: z.literal("circle_region"),
  box: ScreenBox,
  label: Label.optional(),
});
const Underline = z.object({ type: z.literal("underline"), box: ScreenBox });
const Highlight = z.object({ type: z.literal("highlight"), box: ScreenBox });
const PointAt = z.object({
  type: z.literal("point_at"),
  point: ScreenPoint,
  label: Label.optional(),
});
const MarginNote = z.object({
  type: z.literal("margin_note"),
  text: z.string().min(1).max(SCREEN_LIMITS.noteChars),
  besideBox: ScreenBox,
  side: NoteSide.optional(),
});
const WriteStep = z.object({
  type: z.literal("write_step"),
  latexOrText: z.string().min(1).max(SCREEN_LIMITS.stepChars),
  besideBox: ScreenBox,
  side: NoteSide.optional(),
});
const Clear = z.object({ type: z.literal("clear") });

/**
 * The ink the screen tutor's model may ask for (S3, docs/SCREEN_COACH_S3.md §2.1): what's in its
 * response schema. Notes Check's marks (ticks, amber circles) aren't: the desktop app makes those
 * itself from a check's findings, and refuses them in a tutor reply.
 */
export const TutorScreenAction = z.discriminatedUnion("type", [
  /** What the tutor is talking about: anchors placement and is the default clip crop. */
  FocusRegion,
  CircleRegion,
  Underline,
  /** A translucent marker stroke over a line of text. */
  Highlight,
  /** An arrow to a spot, with an optional short handwritten label. */
  PointAt,
  /** A few handwritten words in the free space beside a box. */
  MarginNote,
  /** A hint or first step (LaTeX or plain text) beside a box. */
  WriteStep,
  Clear,
]);
export type TutorScreenAction = z.infer<typeof TutorScreenAction>;

/** A colour variant of the tutor's ink: "question" is amber (Notes Check: look again here). */
export const InkTone = z.enum(["question"]);
export type InkTone = z.infer<typeof InkTone>;

/** Ink the overlay draws on screen: the tutor's, plus Notes Check's marks (N4). */
export const ScreenAction = z.discriminatedUnion("type", [
  FocusRegion,
  CircleRegion.extend({ tone: InkTone.optional() }),
  Underline,
  Highlight,
  PointAt,
  MarginNote,
  WriteStep,
  /** Notes Check: a small tick beside text the student's notes already have. */
  z.object({ type: z.literal("check_mark"), box: ScreenBox }),
  Clear,
]);
export type ScreenAction = z.infer<typeof ScreenAction>;

export const ScreenMode = z.enum(["answer", "coach_step", "coach_complete", "quiz"]);
export type ScreenMode = z.infer<typeof ScreenMode>;

/** What the screen tutor model returns. `speech` comes first so it can be spoken early. */
export const ScreenTutorResponse = z.object({
  speech: z.string().min(1).max(SCREEN_LIMITS.speechChars),
  actions: z.array(TutorScreenAction).max(SCREEN_LIMITS.actions),
  mode: ScreenMode,
  /** The video player's current time, when one is visible (for a saved clip's link). */
  videoTimeSec: z.number().int().min(0).max(SCREEN_LIMITS.videoSeconds).optional(),
});
export type ScreenTutorResponse = z.infer<typeof ScreenTutorResponse>;

/** Actions that draw something, with the box they're about (focus_region and clear don't). */
const DRAWN_BOX = (action: TutorScreenAction): ScreenBox | null => {
  switch (action.type) {
    case "circle_region":
    case "underline":
    case "highlight":
      return action.box;
    case "margin_note":
    case "write_step":
      return action.besideBox;
    case "point_at":
      return {
        left: action.point.x,
        top: action.point.y,
        right: action.point.x,
        bottom: action.point.y,
      };
    case "focus_region":
    case "clear":
      return null;
  }
};

/**
 * Every annotated reply has exactly one focus region (brief §2.1): the first one the model gave,
 * or, if it forgot, the box around everything it drew. Replies without ink are left alone.
 */
export function withFocusRegion(response: ScreenTutorResponse): ScreenTutorResponse {
  const boxes = response.actions.map(DRAWN_BOX).filter((b): b is ScreenBox => b !== null);
  const focus = response.actions.find((a) => a.type === "focus_region");
  const others = response.actions.filter((a) => a.type !== "focus_region");
  if (focus) return { ...response, actions: [focus, ...others] };
  if (boxes.length === 0) return response;
  const box = boxes.reduce((a, b) => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }));
  // A point alone has no area; and the cap on actions still holds after adding one.
  const derived: TutorScreenAction = { type: "focus_region", box, kind: "text" };
  return {
    ...response,
    actions: [derived, ...others].slice(0, SCREEN_LIMITS.actions),
  };
}

/** Lowercase executable name of the app in front, e.g. "excel.exe" (never a path). */
export const AppName = z
  .string()
  .max(64)
  .regex(/^[a-z0-9 ._+()-]+\.exe$/);

export const ScreenImage = z.object({
  /** Base64 JPEG, already redacted on the device. Never stored. */
  jpeg: z.string().min(1).max(SCREEN_LIMITS.imageBase64Chars),
  width: z.number().int().min(1).max(SCREEN_LIMITS.imagePixelsPerSide),
  height: z.number().int().min(1).max(SCREEN_LIMITS.imagePixelsPerSide),
});

/** `POST /api/screen/ask`, sent by the desktop app with its device token. */
export const ScreenAskRequest = z.object({
  /** What the student asked (empty when they used "Look at my screen" without speaking). */
  transcript: z.string().max(SCREEN_LIMITS.transcriptChars),
  app: AppName.nullable(),
  scope: z.enum(["window", "monitor"]),
  /** A video is playing in the app in front (Windows' media session says so). */
  videoPlaying: z.boolean().optional(),
  /** Asked in the middle of a walkthrough (S4): the tutor answers in its context. */
  walkthroughId: z.uuid().optional(),
  image: ScreenImage,
});
export type ScreenAskRequest = z.infer<typeof ScreenAskRequest>;

/** Newline-delimited JSON events streamed by `POST /api/screen/ask`. */
export const ScreenStreamEvent = z.discriminatedUnion("type", [
  /** The spoken reply, as soon as it's complete and has passed the safety check. */
  z.object({ type: z.literal("speech"), text: z.string(), latencyMs: z.number() }),
  /** The full validated, safety-checked response. */
  z.object({
    type: z.literal("response"),
    response: ScreenTutorResponse,
    turnId: z.uuid(),
    latencyMs: z.number(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ScreenStreamEvent = z.infer<typeof ScreenStreamEvent>;

/**
 * `POST /api/screen/reanchor`: "show that again" after the page moved, when the desktop app
 * couldn't find the focus region's text on the new screen itself (decision 9).
 */
export const ScreenReanchorRequest = z.object({
  app: AppName.nullable(),
  scope: z.enum(["window", "monitor"]),
  /** What the earlier ink was about: its kind and the text that was in it (may be empty). */
  focus: z.object({ kind: FocusKind, text: z.string().max(300) }),
  /** The earlier ink, in the earlier screenshot's coordinates. */
  previous: z.array(ScreenAction).min(1).max(SCREEN_LIMITS.actions),
  image: ScreenImage,
});
export type ScreenReanchorRequest = z.infer<typeof ScreenReanchorRequest>;

/** The model's answer: the same ink moved onto the new screenshot, or not found. */
export const ScreenReanchorResponse = z.object({
  found: z.boolean(),
  actions: z.array(ScreenAction).max(SCREEN_LIMITS.actions),
});
export type ScreenReanchorResponse = z.infer<typeof ScreenReanchorResponse>;
