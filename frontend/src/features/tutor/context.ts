import { type PageDocument, unionBBox } from "@mew/ink";
import {
  type AnswerStyle,
  MEW_LIMITS,
  type RecognizedLine,
  TUTOR_LIMITS,
  type TutorRequest,
} from "@mew/shared";

import { blobToBase64, renderStrokesPng, strokesOf, studentLines } from "../notebook/export-line";
import type { RecognitionService } from "./recognition";

/** How many of the most recently written lines the tutor sees. */
const RECENT_LINES = 3;
const DEEP_REQUEST =
  /\b(explain|in detail|step by step|walk me through|go through|why exactly|deeply)\b/i;

type ContextInput = {
  intent: TutorRequest["intent"];
  utterance: string;
  transcript: readonly string[];
  previousSpeech: readonly string[];
  answerStyle: AnswerStyle;
  doc: PageDocument | null;
  recognition: RecognitionService;
};

/**
 * Builds what the tutor sees: the conversation, a PNG of the student's most recent lines, and
 * any recognised text for those lines. Missing recognitions are requested for next time.
 */
export async function buildTutorRequest(input: ContextInput): Promise<TutorRequest> {
  const { doc, recognition } = input;
  const recent = doc
    ? [...studentLines(doc)]
        .sort((a, b) => b.lastCreatedAt - a.lastCreatedAt)
        .slice(0, RECENT_LINES)
    : [];

  let pageImage: string | null = null;
  const recognizedLines: RecognizedLine[] = [];
  if (doc && recent.length > 0) {
    const bbox = recent.map((l) => l.bbox).reduce(unionBBox);
    const raster = await renderStrokesPng(strokesOf(doc, recent), bbox);
    const base64 = await blobToBase64(raster.blob);
    pageImage = base64.length <= TUTOR_LIMITS.imageBase64Chars ? base64 : null;

    for (const line of [...recent].reverse()) {
      const known = recognition.cached(doc, line);
      if (known) recognizedLines.push({ lineId: line.id, text: known.text, latex: known.latex });
      else void recognition.recognize(doc, line);
    }
  }

  return {
    intent: input.intent,
    lastUtterance: clip(input.utterance, MEW_LIMITS.utteranceChars),
    recentTranscript: input.transcript.slice(-6).map((t) => clip(t, MEW_LIMITS.utteranceChars)),
    pageImage,
    recognizedLines,
    answerStyle: input.answerStyle,
    depth: DEEP_REQUEST.test(input.utterance) ? "deep" : "normal",
    previousTutorSpeech: input.previousSpeech
      .slice(-3)
      .map((s) => clip(s, TUTOR_LIMITS.speechChars)),
  };
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}
