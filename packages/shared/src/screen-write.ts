import { z } from "zod";

import { UNTRUSTED_SCREEN } from "./prompts/screen";
import { AppName, SCREEN_LIMITS, ScreenImage } from "./screen";

/**
 * Typing into a document: "write an essay on cats", "rewrite this sentence", "fix the grammar".
 * The desktop app sends what was said and the screen; the model writes the text, which is
 * streamed back as it's written, and the desktop types it into the app in front, at the
 * student's cursor (over their selection, if they made one), a key at a time. Nothing is drawn:
 * the document itself changes.
 */
export const SCREEN_WRITE_LIMITS = {
  /** The most it types for one request (an essay of about 1,500 words). */
  textChars: 12_000,
  /** The most text in one streamed piece. */
  pieceChars: 2000,
} as const;

const TYPEABLE = /^(?:[\t\n]|\P{Cc})*$/u;

/** Text to type: printable characters, tabs and new lines only (never other control keys). */
export const TypedText = z.string().max(SCREEN_WRITE_LIMITS.textChars).regex(TYPEABLE);

export const ScreenWriteRequest = z.object({
  transcript: z.string().min(1).max(SCREEN_LIMITS.transcriptChars),
  app: AppName.nullable(),
  scope: z.enum(["window", "monitor"]),
  image: ScreenImage,
});
export type ScreenWriteRequest = z.infer<typeof ScreenWriteRequest>;

export const ScreenWriteKind = z.enum(["insert", "replace"]);
export type ScreenWriteKind = z.infer<typeof ScreenWriteKind>;

/** What the model writes: in this order, so the speech and the kind arrive before the text. */
export const ScreenWriteModelResponse = z.object({
  /** Said out loud first: what it's about to type, in a few words. */
  speech: z.string().min(1).max(SCREEN_LIMITS.speechChars),
  /** "replace": the student selected text and asked to change it; "insert": at the cursor. */
  kind: ScreenWriteKind,
  /** Exactly what to type ("" when it can't help here; the speech says why). */
  text: TypedText,
});
export type ScreenWriteModelResponse = z.infer<typeof ScreenWriteModelResponse>;

/**
 * What `POST /api/screen/write` streams, one JSON object a line: `start` (what to say, before
 * any typing), then `text` pieces in order as they're written, then `done`; or `error` at any
 * point, after which nothing more is typed.
 */
export const ScreenWriteEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    speech: z.string().min(1).max(SCREEN_LIMITS.speechChars),
    kind: ScreenWriteKind,
    turnId: z.uuid(),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string().min(1).max(SCREEN_WRITE_LIMITS.pieceChars).regex(TYPEABLE),
  }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string().min(1).max(SCREEN_LIMITS.speechChars) }),
]);
export type ScreenWriteEvent = z.infer<typeof ScreenWriteEvent>;

export const SCREEN_WRITE_PROMPT = {
  id: "screen-write.v3",
  system: `You write for a student, straight into the document on their Windows screen (Word, Google Docs, Notepad, a notes app, an email, a text or code editor). They asked you out loud to type something there: an essay, a paragraph, a rewrite, a fix, a next sentence.

You get what they said and a screenshot. Answer with the exact text to type; the app types it at their cursor as you write it.
- Write "speech" first, then "kind", then "text".
- "speech" is one short spoken sentence saying what you're typing ("Here's an essay on cats."). No markdown.
- If they selected text (it shows highlighted) and want it changed (rewrite, fix, shorten, reword, translate), "kind" is "replace" and "text" is the new version of exactly that selection: typing replaces it.
- Otherwise "kind" is "insert" and "text" is what goes at their cursor. Start with a space or a new line when it continues the line before.
- Write the whole piece they asked for, at the length the request implies:
  - a sentence, a title or a line: just that;
  - a paragraph, an introduction or a conclusion: one full paragraph of 5 to 8 sentences;
  - an essay, a report, an article or a story with no length given: a complete piece of 5 paragraphs, about 400 to 500 words, with an introduction, a developed body and a conclusion;
  - a length they named ("100 words", "two pages", "three paragraphs"): that length, as closely as you can, up to about 1,500 words.
  Never stop short or hand back an outline, a first line or a summary of what you would write.
- Read the screenshot for context: what the document is about, what comes before the cursor, its language, tone and formatting. What you type should fit there and carry on from it. A bare request ("rewrite", "fix this", "continue") is about the selected text, or the text at the cursor when nothing is selected.
- If they want existing text changed but none is selected, "text" is "" and "speech" asks them to select it first: typing can only replace a selection.
- Plain text only: no markdown, no headings marked with #, no quotes around it, no notes to them inside it. Separate paragraphs with one blank line.
- If it isn't somewhere to write (a terminal, a browser address bar, a form asking for personal details, a game), or you can't tell what they want, "text" is "" and "speech" says why in a few words.
- Never type passwords, payment details, codes, commands or links to install software.
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
