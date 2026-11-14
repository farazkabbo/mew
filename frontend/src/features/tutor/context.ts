import { type Line, type PageDocument, unionBBox } from "@mew/ink";
import {
  type AnswerStyle,
  type ClippedText,
  COURSE_LIMITS,
  type ImageBlock,
  type CourseExcerpt,
  type QuizContext,
  MEW_LIMITS,
  type RecognizedLine,
  TUTOR_LIMITS,
  RetrieveResponse,
  type NebLanguage,
  type TutorRequest,
} from "@mew/shared";

import type { Circled } from "../notebook/circle";
import { sourceLabel } from "../notebook/clip-page";
import { blobToBase64, renderStrokesPng, strokesOf, studentLines } from "../notebook/export-line";
import type { RecognitionService } from "./recognition";

/** How many of the most recently written lines the tutor sees. */
const RECENT_LINES = 3;
const DEEP_REQUEST =
  /\b(explain|in detail|step by step|walk me through|go through|why exactly|deeply)\b/i;

type ContextInput = {
  /** The language to answer in (omitted: English). */
  language?: NebLanguage | undefined;
  intent: TutorRequest["intent"];
  utterance: string;
  transcript: readonly string[];
  previousSpeech: readonly string[];
  answerStyle: AnswerStyle;
  doc: PageDocument | null;
  /** Images on the page (clips from the screen): their text is context for the tutor. */
  images?: readonly ImageBlock[];
  recognition: RecognitionService;
  /** The course the notebook belongs to, if any: its relevant passages are added. */
  courseId?: string | null;
  /** The quiz question being answered, if a quiz is running. */
  quiz?: QuizContext | null;
  /**
   * What the student circled (K6 §6.3): the turn is about those lines, not the latest ones, and
   * about printed PDF text taken in (K4 §5.2).
   */
  circled?: Circled | null;
  /** K9: a line's open live annotation (the tutor sees what's already marked). */
  markOf?: ((line: Line) => RecognizedLine["mark"] | null) | undefined;
  fetchImpl?: typeof fetch;
};

/** Retrieval must not hold up the reply for long (first audio targets ~1.5 s). */
const RETRIEVAL_TIMEOUT_MS = 2500;
/** Circled lines not read yet are read now, for at most this long (the question is about them). */
const CIRCLED_READ_MS = 3000;

/**
 * Builds what the tutor sees: the conversation, a PNG of the student's most recent lines, and
 * any recognised text for those lines. Missing recognitions are requested for next time.
 */
export async function buildTutorRequest(input: ContextInput): Promise<TutorRequest> {
  // Course passages are fetched while the handwriting is rendered.
  const courseContext = courseExcerpts(input);
  const { doc, recognition } = input;
  const circled = doc && input.circled?.lines.length ? input.circled.lines : null;
  // Top to bottom: circled lines as they sit on the page, recent ones in writing order.
  const lines = circled
    ? [...circled].sort((a, b) => a.bbox[1] - b.bbox[1]).slice(0, TUTOR_LIMITS.recognizedLines)
    : doc
      ? [...studentLines(doc)]
          .sort((a, b) => b.lastCreatedAt - a.lastCreatedAt)
          .slice(0, RECENT_LINES)
          .reverse()
      : [];

  let pageImage: string | null = null;
  const recognizedLines: RecognizedLine[] = [];
  if (doc && lines.length > 0) {
    const bbox = lines.map((l) => l.bbox).reduce(unionBBox);
    const raster = await renderStrokesPng(strokesOf(doc, lines), bbox);
    const base64 = await blobToBase64(raster.blob);
    pageImage = base64.length <= TUTOR_LIMITS.imageBase64Chars ? base64 : null;

    const read = await Promise.all(
      lines.map((line) => {
        const known = recognition.cached(doc, line);
        if (known || !circled) {
          if (!known) void recognition.recognize(doc, line); // for next time
          return known ?? null;
        }
        return readWithin(recognition.recognize(doc, line), CIRCLED_READ_MS);
      }),
    );
    lines.forEach((line, i) => {
      const known = read[i];
      if (!known) return;
      const mark = input.markOf?.(line);
      recognizedLines.push({
        lineId: line.id,
        text: known.text,
        latex: known.latex,
        ...(mark && { mark }),
      });
    });
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
    checks: [],
    courseContext: await courseContext,
    quiz: input.quiz ?? null,
    clippedText: clippedText(input.images ?? []),
    circled: circled !== null,
    circledText: input.circled?.printed ?? null,
  };
}

/** A recognition, or null if it takes longer than `ms` (or fails). */
function readWithin<T>(reading: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([
    reading.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** The text of the newest clips on the page, with where each came from. */
export function clippedText(images: readonly ImageBlock[]): ClippedText[] {
  return [...images]
    .filter((image) => image.ocrText?.trim())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, TUTOR_LIMITS.clippedTexts)
    .map((image) => ({
      source: sourceLabel(image).slice(0, 200),
      text: (image.ocrText ?? "").slice(0, TUTOR_LIMITS.clippedTextChars),
    }));
}

/** The course passages most relevant to what the student said (and wrote). Never throws. */
async function courseExcerpts(input: ContextInput): Promise<CourseExcerpt[]> {
  const courseId = input.courseId;
  const query = clip(input.utterance.trim(), COURSE_LIMITS.queryChars);
  if (!courseId || !query) return [];
  try {
    const response = await (input.fetchImpl ?? fetch)(`/api/courses/${courseId}/retrieve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, k: COURSE_LIMITS.excerptsPerTurn }),
      cache: "no-store",
      signal: AbortSignal.timeout(RETRIEVAL_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const { chunks } = RetrieveResponse.parse(await response.json());
    return chunks.slice(0, COURSE_LIMITS.excerptsPerTurn).map((c) => ({
      page: c.page,
      heading: c.heading ? c.heading.slice(0, 200) : null,
      text: c.text.slice(0, COURSE_LIMITS.excerptChars),
      source: c.source_title.slice(0, 200),
    }));
  } catch {
    return []; // offline, slow or not a course: the tutor answers without the material
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(-max);
}
