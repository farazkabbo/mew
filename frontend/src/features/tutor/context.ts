import { type PageDocument, unionBBox } from "@mew/ink";
import {
  type AnswerStyle,
  COURSE_LIMITS,
  type CourseExcerpt,
  type QuizContext,
  MEW_LIMITS,
  type RecognizedLine,
  TUTOR_LIMITS,
  RetrieveResponse,
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
  /** The course the notebook belongs to, if any: its relevant passages are added. */
  courseId?: string | null;
  /** The quiz question being answered, if a quiz is running. */
  quiz?: QuizContext | null;
  fetchImpl?: typeof fetch;
};

/** Retrieval must not hold up the reply for long (first audio targets ~1.5 s). */
const RETRIEVAL_TIMEOUT_MS = 2500;

/**
 * Builds what the tutor sees: the conversation, a PNG of the student's most recent lines, and
 * any recognised text for those lines. Missing recognitions are requested for next time.
 */
export async function buildTutorRequest(input: ContextInput): Promise<TutorRequest> {
  // Course passages are fetched while the handwriting is rendered.
  const courseContext = courseExcerpts(input);
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
    checks: [],
    courseContext: await courseContext,
    quiz: input.quiz ?? null,
  };
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
