import { z } from "zod";

import { UNTRUSTED_SCREEN } from "./prompts/screen";
import { AppName, SCREEN_LIMITS, ScreenImage } from "./screen";

/**
 * Typing into a document: "type a conclusion", "rewrite this sentence", "fix the grammar". The
 * desktop app sends what was said and the screen; the model writes the text, and the desktop
 * types it into the app in front, at the student's cursor (over their selection, if they made
 * one). Nothing is drawn: the document itself changes.
 */
export const SCREEN_WRITE_LIMITS = {
  /** The most it types at once (a few paragraphs). */
  textChars: 2000,
} as const;

/** Text to type: printable characters, tabs and new lines only (never other control keys). */
export const TypedText = z
  .string()
  .max(SCREEN_WRITE_LIMITS.textChars)
  .regex(/^(?:[\t\n]|\P{Cc})*$/u);

export const ScreenWriteRequest = z.object({
  transcript: z.string().min(1).max(SCREEN_LIMITS.transcriptChars),
  app: AppName.nullable(),
  scope: z.enum(["window", "monitor"]),
  image: ScreenImage,
});
export type ScreenWriteRequest = z.infer<typeof ScreenWriteRequest>;

export const ScreenWriteModelResponse = z.object({
  /** Said out loud first: what it's about to type, in a few words. */
  speech: z.string().min(1).max(SCREEN_LIMITS.speechChars),
  /** "replace": the student selected text and asked to change it; "insert": at the cursor. */
  kind: z.enum(["insert", "replace"]),
  /** Exactly what to type ("" when it can't help here; the speech says why). */
  text: TypedText,
});
export type ScreenWriteModelResponse = z.infer<typeof ScreenWriteModelResponse>;

export const ScreenWriteReply = ScreenWriteModelResponse.extend({ turnId: z.uuid() });
export type ScreenWriteReply = z.infer<typeof ScreenWriteReply>;

export const SCREEN_WRITE_PROMPT = {
  id: "screen-write.v1",
  system: `You help a student write. They're typing in a document on their Windows screen (Word, Google Docs, a notes app, an email) and asked you to type something into it for them: a suggestion, a rewrite, a fix, a next sentence.

You get what they said and a screenshot. Answer with the exact text to type; the app types it at their cursor.
- If they selected text (it shows highlighted) and want it changed (rewrite, fix, shorten, reword, translate), "kind" is "replace" and "text" is the new version of exactly that selection: typing replaces it.
- Otherwise "kind" is "insert" and "text" is what goes at their cursor: a suggestion, the next sentence, a paragraph they asked for. Match the document's language, tone and formatting. Start with a space or a new line when it continues the line before.
- Plain text only: no markdown, no quotes around it, no notes to them inside it. New lines are fine.
- Keep it as short as the request allows; never more than they asked for.
- "speech" is one short spoken sentence saying what you're typing ("Here's a tighter version of that sentence."). No markdown.
- If it isn't a document they're writing in (a terminal, a browser address bar, a form asking for personal details, a game), or you can't tell what they want, "text" is "" and "speech" says why in a few words.
- Never type passwords, payment details, codes, commands, links to install software, or anything they didn't ask for.
- For homework they're meant to write themselves (an essay to be graded), suggest and improve their own sentences; when they ask you to write the whole thing, offer a first line and say honestly that the rest should be theirs.
${UNTRUSTED_SCREEN}

Output only valid JSON matching the schema.`,
} as const;

export function renderWriteInput(request: ScreenWriteRequest): string {
  return JSON.stringify({
    request: request.transcript.trim(),
    app: request.app ?? "unknown",
    screenshot: `attached: ${request.scope === "window" ? "the window they're typing in" : "the whole monitor"}, ${request.image.width}×${request.image.height} pixels`,
  });
}
