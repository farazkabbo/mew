import { z } from "zod";

import { DEFAULT_HELP_LEVEL, HELP_RULE, HelpLevel } from "./help";
import { UNTRUSTED_SCREEN } from "./prompts/screen";
import { AppName, SCREEN_LIMITS, ScreenImage, TutorScreenAction } from "./screen";

/**
 * Watch (the island's eye button): while it's on, the desktop app looks at the screen every few
 * seconds when it has changed, and asks whether the student's working has a slip in it. Most
 * looks find nothing and say nothing; a slip is said out loud and marked in ink, the way the
 * student's help level says.
 */
export const SCREEN_WATCH_LIMITS = {
  /** What was said last time, so the same slip isn't pointed out twice. */
  previousChars: 300,
} as const;

export const ScreenWatchRequest = z.object({
  app: AppName.nullable(),
  scope: z.enum(["window", "monitor"]),
  help: HelpLevel.optional(),
  /** The last slip pointed out while watching (not said again while it's still there). */
  previous: z.string().max(SCREEN_WATCH_LIMITS.previousChars).optional(),
  image: ScreenImage,
});
export type ScreenWatchRequest = z.infer<typeof ScreenWatchRequest>;

/**
 * What the model answers: "fine" (working with nothing wrong, or only the slip already pointed
 * out), "nothing" (no working on screen), or "mistake" with what to say and the ink.
 */
export const ScreenWatchModelResponse = z.object({
  status: z.enum(["fine", "nothing", "mistake"]),
  speech: z.string().max(SCREEN_LIMITS.speechChars),
  actions: z.array(TutorScreenAction).max(SCREEN_LIMITS.actions),
});
export type ScreenWatchModelResponse = z.infer<typeof ScreenWatchModelResponse>;

/** The reply to the desktop app: speech and actions only for a mistake. */
export const ScreenWatchReply = z.discriminatedUnion("status", [
  z.object({ status: z.literal("fine") }),
  z.object({ status: z.literal("nothing") }),
  z.object({
    status: z.literal("mistake"),
    speech: z.string().min(1).max(SCREEN_LIMITS.speechChars),
    actions: z.array(TutorScreenAction).max(SCREEN_LIMITS.actions),
    turnId: z.uuid(),
  }),
]);
export type ScreenWatchReply = z.infer<typeof ScreenWatchReply>;

export const SCREEN_WATCH_PROMPT = {
  id: "screen-watch.v1",
  system: `You are a calm tutor watching the student's Windows screen while they work, because they turned Watch on. You see a new screenshot every so often.

Your job: notice a mistake in the student's own working (maths, a calculation, code, an answer they typed or wrote, a step in a method) and tell them, the way "help" says. Stay quiet otherwise.

- "status" is "nothing" when there's no working of theirs on screen (a video, a menu, a blank page, reading), "fine" when their working has no mistake or the only one is "previous" (already pointed out), and "mistake" when you are sure a step is wrong.
- Only report a mistake you're sure of, in work that's on screen now. A step they haven't finished yet isn't a mistake. Never invent one.
- For "fine" and "nothing", "speech" is "" and "actions" is [].
- For "mistake": "speech" is 1–2 short spoken sentences, no markdown, saying where the slip is and guiding them (per "help"). Draw ink: exactly one "focus_region" first (the working it's in), then "circle_region" or "underline" on the wrong step, and a "margin_note" or "write_step" beside it. At most 4 drawn actions besides the focus region.
${HELP_RULE}
- Coordinates are 0–1000 across the screenshot: x from the left edge, y from the top edge. Boxes are {left, top, right, bottom}. Never put notes on top of text.
${UNTRUSTED_SCREEN}
- Never ask for passwords, payment details or codes.

Output only valid JSON matching the schema.`,
} as const;

export function renderWatchInput(request: ScreenWatchRequest): string {
  return JSON.stringify({
    app: request.app ?? "unknown",
    help: request.help ?? DEFAULT_HELP_LEVEL,
    ...(request.previous && { previous: request.previous }),
    screenshot: `attached: ${request.scope === "window" ? "the window they're working in" : "the whole monitor"}, ${request.image.width}×${request.image.height} pixels`,
  });
}
