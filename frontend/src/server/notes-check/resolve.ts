import "server-only";

import {
  CourseDetail,
  type CoursePassage,
  ExplainOutput,
  type ExplainResult,
  type FindingForFollowUp,
  type FindingStatus,
  GapHeadingOutput,
  type GapHeadingResult,
  matchConcept,
  NOTES_CHECK_LIMITS,
  NOTES_EXPLAIN_PROMPT,
  NOTES_GAP_PROMPT,
  NOTES_RESOLVE_PROMPT,
  renderExplainInput,
  renderGapInput,
  renderResolveInput,
  type ResolveOutcome,
  ResolveOutput,
  type ResolveRequest,
  type ResolveResult,
  StoredFinding,
  unsafeReasons,
  usableSpeech,
} from "@mew/shared";
import { z } from "zod";

import { recordAttempt } from "../attempts";
import { coursesApi } from "../courses";
import { notesModel, verifierModel } from "../env";
import { type GenerateStructured, generateStructured } from "../gemini";
import { HttpError } from "../http-error";
import { userApi } from "../user-api";

/**
 * Notes Check's resolution loop (N5, brief §2.4–2.5, §9): what happened to a finding the
 * student was asked about. Findings change nothing in the learner model; outcomes do:
 *
 * - fixed after the question → "with hint" evidence (a gap filled in their own words:
 *   "independent"), which reschedules the concept's review card;
 * - explained → "after explanation" (the review comes back tomorrow);
 * - the student was right, or dismissed it → nothing at all.
 */

export type ResolveDeps = {
  generate: GenerateStructured;
  finding(id: string): Promise<StoredFinding>;
  update(id: string, status: Exclude<FindingStatus, "open">, conceptId?: string): Promise<void>;
  concepts(courseId: string): Promise<{ id: string; title: string }[]>;
  passage(courseId: string, query: string): Promise<CoursePassage | null>;
  record: typeof recordAttempt;
};

export const defaultResolveDeps = (): ResolveDeps => ({
  generate: generateStructured,
  finding: (id) => userApi(`/v1/notes/findings/${id}`, StoredFinding),
  update: async (id, status, conceptId) => {
    await userApi(`/v1/notes/findings/${id}`, StoredFinding, {
      method: "PATCH",
      body: { status, ...(conceptId && { conceptId }) },
    });
  },
  concepts: async (courseId) =>
    (await coursesApi(`/v1/courses/${courseId}`, CourseDetail)).concepts.map((c) => ({
      id: c.id,
      title: c.title,
    })),
  passage: async (courseId, query) => {
    const { chunks } = await coursesApi(`/v1/courses/${courseId}/retrieve`, Retrieved, {
      method: "POST",
      body: { query, k: 1 },
    });
    const [chunk] = chunks;
    return chunk ? { page: chunk.page, heading: chunk.heading, text: chunk.text } : null;
  },
  record: recordAttempt,
});

const Retrieved = z.object({
  chunks: z.array(z.object({ page: z.number(), heading: z.string().nullable(), text: z.string() })),
});

const TIMEOUT_MS = 10_000;

/** What the student says goes with each outcome when the model's reply can't be used. */
const FALLBACK_REPLY: Record<ResolveOutcome, string> = {
  fixed: "That matches the material now. Nicely done.",
  student_right: "You're right, your note was correct.",
  still_different: "Have another look at what the material says, and compare it with your line.",
  needs_explanation: "Let me explain what the material says.",
};

export async function resolveFinding(
  id: string,
  request: ResolveRequest,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<ResolveResult> {
  const finding = await openFinding(id, deps);
  const output = await deps.generate({
    model: notesModel(),
    system: NOTES_RESOLVE_PROMPT.system,
    input: renderResolveInput(forFollowUp(finding), request),
    schema: ResolveOutput,
    thinkingLevel: "low",
    maxOutputTokens: 512,
    timeoutMs: TIMEOUT_MS,
  });
  const reply = usableSpeech(output.reply) ?? FALLBACK_REPLY[output.outcome];

  let status: FindingStatus = "open";
  if (output.outcome === "fixed") {
    status = "resolved_fixed";
    const conceptId = await learn(finding, deps, {
      correct: true,
      evidence: finding.type === "gap" ? "independent" : "with_hint",
    });
    await deps.update(finding.id, status, conceptId ?? undefined);
  } else if (output.outcome === "student_right") {
    status = "resolved_student_right";
    await deps.update(finding.id, status);
  }
  return { outcome: output.outcome, reply, status };
}

export async function explainFinding(
  id: string,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<ExplainResult> {
  const finding = await openFinding(id, deps);
  const passage = finding.courseId
    ? await deps.passage(finding.courseId, finding.screenSnippet).catch(() => null)
    : null;
  const output = await deps.generate({
    model: notesModel(),
    system: NOTES_EXPLAIN_PROMPT.system,
    input: renderExplainInput(forFollowUp(finding), passage),
    schema: ExplainOutput,
    thinkingLevel: "low",
    maxOutputTokens: 512,
    timeoutMs: TIMEOUT_MS,
  });
  const explanation =
    safeText(output.explanation, 3) ?? `The material says: “${finding.screenSnippet}”.`;
  const conceptId = await learn(finding, deps, { correct: false, evidence: "after_explanation" });
  await deps.update(finding.id, "explained", conceptId ?? undefined);
  return { explanation, status: "explained" };
}

/** A heading for the student to fill in, written in the margin as tutor ink (never content). */
export async function gapHeading(
  id: string,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<GapHeadingResult> {
  const finding = await openFinding(id, deps);
  if (finding.type !== "gap") throw new HttpError(409, "Only a gap gets a heading");
  const fallback = `${(finding.conceptHint ?? "New idea").slice(0, 40)} — ?`;
  const output = await deps
    .generate({
      model: verifierModel(),
      system: NOTES_GAP_PROMPT.system,
      input: renderGapInput(forFollowUp(finding)),
      schema: GapHeadingOutput,
      thinkingLevel: "minimal",
      maxOutputTokens: 128,
      timeoutMs: TIMEOUT_MS,
    })
    .catch(() => null);
  return { heading: headingOf(output?.heading) ?? fallback };
}

export async function dismissFinding(
  id: string,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<void> {
  const finding = await openFinding(id, deps);
  await deps.update(finding.id, "dismissed");
}

/** A heading of at most 6 words ending in "?", safe to write; null otherwise. */
export function headingOf(text: string | undefined): string | null {
  const heading = text?.replace(/\s+/g, " ").trim();
  if (!heading || !heading.endsWith("?") || heading.length > 60) return null;
  if (
    heading
      .replace(/[—–?-]/g, " ")
      .trim()
      .split(/\s+/).length > 6
  )
    return null;
  return unsafeReasons(heading).length === 0 ? heading : null;
}

async function openFinding(id: string, deps: ResolveDeps): Promise<StoredFinding> {
  const finding = await deps.finding(id);
  if (finding.status !== "open") throw new HttpError(409, "That's already settled");
  return finding;
}

function forFollowUp(finding: StoredFinding): FindingForFollowUp {
  return {
    type: finding.type,
    noteQuote: finding.noteQuote,
    screenQuote: finding.screenSnippet,
    question: finding.question,
    sourceConflict: finding.sourceConflict,
  };
}

/**
 * Evidence on the finding's concept, when the check was about a course and its concept is known
 * (or can be matched by name). Returns the concept, or null when there's nothing to record on.
 */
async function learn(
  finding: StoredFinding,
  deps: ResolveDeps,
  answer: { correct: boolean; evidence: "independent" | "with_hint" | "after_explanation" },
): Promise<string | null> {
  if (!finding.courseId) return null;
  const conceptId =
    finding.conceptId ??
    matchConcept(finding.conceptHint, await deps.concepts(finding.courseId).catch(() => []));
  if (!conceptId) return null;
  await deps.record(finding.courseId, { conceptId, ...answer, source: "notes_check" });
  return conceptId;
}

/** Text to show or say: safe, gentle, at most `sentences` sentences; null otherwise. */
function safeText(text: string, sentences: number): string | null {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, NOTES_CHECK_LIMITS.speechChars);
  if (!clean || unsafeReasons(clean).length > 0 || /\b(?:wrong|mistakes?)\b/i.test(clean))
    return null;
  return clean.split(/(?<=[.?!])\s+/).length <= sentences ? clean : null;
}
