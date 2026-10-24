import "server-only";

import {
  asMatch,
  capByType,
  type CheckedFinding,
  type CompareInput,
  type CoursePassage,
  NOTES_CHECK_LIMITS,
  NOTES_COMPARE_PROMPT,
  NOTES_SECOND_OPINION_PROMPT,
  NotesCompareOutput,
  renderCompareInput,
  renderSecondOpinionInput,
  sameNotableFindings,
  SecondOpinion,
  summarySpeech,
  usableSpeech,
  validateFindings,
} from "@mew/shared";

import type { GenerateStructured } from "../gemini";

/**
 * The comparison of a screen with the notes related to it (Notes Check §6), after retrieval:
 *
 * 1. one structured call to the comparison model (few-shot prompt, schema);
 * 2. the validation layer (ids, exact quotes, confidence, clip lines, tone, safety, caps);
 * 3. SymPy on maths claims: an equivalent "difference" becomes a match; a confirmed one gains
 *    confidence;
 * 4. a second opinion on every remaining difference (a cheap model that sees only the two quotes
 *    and the course passage): without agreement, the difference becomes a question ("unclear");
 * 5. the spoken summary, rebuilt from the findings if validation changed what it talked about.
 */

export type MathVerdict = "equivalent" | "different" | "unknown";

export type CompareDeps = {
  generate: GenerateStructured;
  /** SymPy on (note, screen) LaTeX pairs; "unknown" for every pair when it can't run. */
  equivalence(pairs: { note: string; screen: string }[]): Promise<MathVerdict[]>;
  models: { compare: string; verifier: string };
};

export type Comparison = {
  topic: string;
  speech: string;
  findings: CheckedFinding[];
  /** For logs and evals: counts only. */
  stats: {
    dropped: Record<string, number>;
    downgraded: number;
    sympyMatches: number;
    secondOpinionDowngrades: number;
  };
};

const COMPARE_TIMEOUT_MS = 15_000;
const VERIFY_TIMEOUT_MS = 6_000;

export async function compareNotes(
  input: CompareInput,
  deps: CompareDeps,
  signal?: AbortSignal,
): Promise<Comparison> {
  const output = await deps.generate({
    model: deps.models.compare,
    system: NOTES_COMPARE_PROMPT.system,
    input: renderCompareInput(input),
    schema: NotesCompareOutput,
    thinkingLevel: "low",
    maxOutputTokens: 3072,
    timeoutMs: COMPARE_TIMEOUT_MS,
    ...(signal && { signal }),
  });

  const validation = validateFindings(output, {
    blocks: input.screen,
    lines: input.notes.map((n) => ({
      id: n.id,
      text: n.text,
      confidence: n.confidence,
      source: n.source,
    })),
  });
  const latexOf = new Map(input.notes.map((n) => [n.id, n.latex]));
  const afterMaths = await checkMaths(validation.findings, latexOf, deps);
  const passage = input.course[0] ?? null;
  const afterOpinions = await secondOpinions(afterMaths.findings, passage, deps, signal);
  const findings = capByType(afterOpinions.findings);

  const modelSpeech = usableSpeech(output.speech);
  const speech =
    modelSpeech && sameNotableFindings(output.findings, findings)
      ? modelSpeech
      : summarySpeech(findings);
  return {
    topic: output.topic.trim().slice(0, NOTES_CHECK_LIMITS.topicChars),
    speech,
    findings,
    stats: {
      dropped: validation.dropped,
      downgraded: validation.downgraded,
      sympyMatches: afterMaths.converted,
      secondOpinionDowngrades: afterOpinions.downgraded,
    },
  };
}

/**
 * Maths claims in differences go to SymPy: equivalent → a match (never accuse a correct
 * rearrangement); different → more confidence. The note side uses the line's own recognised
 * LaTeX when the model gave none.
 */
async function checkMaths(
  findings: CheckedFinding[],
  latexOf: ReadonlyMap<string, string | null>,
  deps: CompareDeps,
): Promise<{ findings: CheckedFinding[]; converted: number }> {
  const candidates = findings
    .map((finding, index) => {
      const note = finding.noteMath ?? latexOf.get(finding.lineIds[0] ?? "") ?? null;
      return { index, note, screen: finding.screenMath ?? null };
    })
    .filter(
      (c): c is { index: number; note: string; screen: string } =>
        findings[c.index]?.type === "difference" && c.note !== null && c.screen !== null,
    )
    .slice(0, 5);
  if (candidates.length === 0) return { findings, converted: 0 };

  let verdicts: MathVerdict[];
  try {
    verdicts = await deps.equivalence(candidates.map(({ note, screen }) => ({ note, screen })));
  } catch {
    return { findings, converted: 0 }; // the verifier is extra evidence, never required
  }
  const updated = [...findings];
  let converted = 0;
  candidates.forEach((candidate, i) => {
    const finding = updated[candidate.index];
    if (!finding) return;
    if (verdicts[i] === "equivalent") {
      converted++;
      updated[candidate.index] = asMatch(finding, "sympy");
    } else if (verdicts[i] === "different") {
      updated[candidate.index] = {
        ...finding,
        confidence: Math.max(finding.confidence, 0.9),
        evidence: [...finding.evidence, "sympy"],
      };
    }
  });
  return { findings: updated, converted };
}

/**
 * An independent check of each difference (brief §6.5), in parallel. A difference stays only if
 * the second opinion also sees a conflict; otherwise (or if the call fails) it becomes a question
 * ("unclear"). Precision first.
 */
async function secondOpinions(
  findings: CheckedFinding[],
  passage: CoursePassage | null,
  deps: CompareDeps,
  signal?: AbortSignal,
): Promise<{ findings: CheckedFinding[]; downgraded: number }> {
  let downgraded = 0;
  const checked = await Promise.all(
    findings.map(async (finding) => {
      if (finding.type !== "difference" || !finding.noteQuote) return finding;
      const conflict = await deps
        .generate({
          model: deps.models.verifier,
          system: NOTES_SECOND_OPINION_PROMPT.system,
          input: renderSecondOpinionInput(finding.noteQuote, finding.screenQuote, passage),
          schema: SecondOpinion,
          thinkingLevel: "low",
          maxOutputTokens: 256,
          timeoutMs: VERIFY_TIMEOUT_MS,
          ...(signal && { signal }),
        })
        .then((opinion) => opinion.conflict)
        .catch(() => false);
      if (conflict)
        return { ...finding, evidence: [...finding.evidence, "second_opinion" as const] };
      downgraded++;
      return { ...finding, type: "unclear" as const, sourceConflict: false };
    }),
  );
  return { findings: checked, downgraded };
}
