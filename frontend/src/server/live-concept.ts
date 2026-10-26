import "server-only";

import {
  CourseDetail,
  LIVE_CONCEPT_PROMPT,
  type LiveConceptRequest,
  renderLiveConceptInput,
} from "@mew/shared";
import { z } from "zod";

import { coursesApi } from "./courses";
import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";

const TIMEOUT_MS = 6_000;
const MAX_CONCEPTS = 60;

/** The model's answer, before it's checked against the course's own concepts. */
const Answer = z.object({ conceptId: z.string().max(40).nullable() });

/**
 * The course concept a line of verified working practises (K9 §7.4), or null. The concepts are
 * the student's own course's, read here with their session; an id that isn't one of them is
 * never returned.
 */
export async function liveConcept(
  request: LiveConceptRequest,
  deps: {
    course?: (id: string) => Promise<CourseDetail>;
    generate?: GenerateStructured;
  } = {},
): Promise<string | null> {
  const course = await (deps.course ?? ((id) => coursesApi(`/v1/courses/${id}`, CourseDetail)))(
    request.courseId,
  );
  const concepts = course.concepts.slice(0, MAX_CONCEPTS).map((c) => ({
    id: c.id,
    title: c.title.slice(0, 120),
    summary: c.summary.slice(0, 200),
  }));
  if (concepts.length === 0) return null;
  const { conceptId } = await (deps.generate ?? generateStructured)({
    model: geminiEnv().GEMINI_VERIFIER_MODEL,
    system: LIVE_CONCEPT_PROMPT.system,
    input: [{ type: "text", text: renderLiveConceptInput({ lines: request.lines, concepts }) }],
    schema: Answer,
    thinkingLevel: "low",
    maxOutputTokens: 256,
    timeoutMs: TIMEOUT_MS,
  });
  return conceptId && concepts.some((c) => c.id === conceptId) ? conceptId : null;
}
