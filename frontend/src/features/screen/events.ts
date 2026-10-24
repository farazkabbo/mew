import { SCREEN_LIMITS, ScreenTutorResponse } from "@mew/shared";
import { z } from "zod";

/**
 * Events the desktop app dispatches on this page (desktop/src-tauri/src/screen/ask.rs). Their
 * payloads come from Rust, which validated the server's reply; they're checked again here
 * because the page treats everything it didn't produce as data.
 */
export const SCREEN_EVENTS = {
  /** The hold-to-talk hotkey went down: start listening. */
  listen: "mew:screen-listen",
  /** The hotkey came up: finish the question and ask. */
  release: "mew:screen-release",
  /** The capture was refused or failed: stop listening, don't ask. */
  cancel: "mew:screen-cancel",
  /** The spoken reply, as soon as it's known. */
  speech: "mew:screen-speech",
  /** The full reply. */
  answer: "mew:screen-answer",
  /** Coach mode (S4): a line to say now, whatever else is being said. */
  say: "mew:screen-say",
  /** A clip was saved from the screen (S3): build its notebook page. */
  clipSaved: "mew:screen-clip-saved",
  /** A notes check's findings (Notes Check): mark the notebook's lines. */
  notesChecked: "mew:screen-notes-checked",
  /** "Show in notebook" in the desktop panel: open that finding's line. */
  notesOpen: "mew:screen-notes-open",
} as const;

/** Asks the open notebook to build (and show) the page for a saved clip. */
export const OPEN_CLIP_EVENT = "mew:open-clip";

export const ScreenClipSavedDetail = z.object({ clipId: z.uuid() });

export const ScreenNotesOpenDetail = z.object({ findingId: z.uuid() });
export type ScreenClipSavedDetail = z.infer<typeof ScreenClipSavedDetail>;

export const ScreenSpeechDetail = z.object({
  text: z.string().min(1).max(SCREEN_LIMITS.speechChars),
});

export const ScreenAnswerDetail = z.object({
  turnId: z.uuid(),
  response: ScreenTutorResponse,
});
export type ScreenAnswerDetail = z.infer<typeof ScreenAnswerDetail>;
