import {
  type FindingEvidence,
  type FindingType,
  type ModelFinding,
  NOTES_CHECK_LIMITS as LIMITS,
  type NotesCompareOutput,
  type ScreenTextBlock,
} from "./notes-check";
import { unsafeReasons } from "./screen-safety";

/**
 * The validation layer of Notes Check (docs/SCREEN_COACH_NOTES_CHECK.md §6.4): code, not prompt,
 * between the model's findings and the student. A false accusation is the worst failure, so
 * every rule here errs towards dropping or downgrading a difference, never towards making one.
 */

/** A note line as validation needs it (ids are the prompt's short ones). */
export type ValidationLine = {
  id: string;
  text: string;
  confidence: number;
  source: "ink" | "clip";
};

export type ValidationInput = {
  blocks: readonly ScreenTextBlock[];
  lines: readonly ValidationLine[];
};

/** A finding that passed validation (still with the prompt's short line ids). */
export type CheckedFinding = {
  type: FindingType;
  lineIds: string[];
  blockIds: string[];
  noteQuote?: string;
  screenQuote: string;
  explanation: string;
  question?: string;
  insertAfter?: string;
  sourceConflict: boolean;
  conceptHint?: string;
  noteMath?: string;
  screenMath?: string;
  confidence: number;
  evidence: FindingEvidence[];
};

export type DropReason =
  | "unknown_ids"
  | "quote_not_found"
  | "missing_quote"
  | "missing_question"
  | "low_confidence"
  | "clip_line"
  | "tone"
  | "unsafe"
  | "heading_gap"
  | "inconsistent"
  | "duplicate"
  | "over_cap";

export type Validation = {
  findings: CheckedFinding[];
  dropped: Partial<Record<DropReason, number>>;
  /** Differences turned into "unclear" (handwriting too uncertain to judge). */
  downgraded: number;
};

const CAPS: Record<FindingType, number> = {
  difference: LIMITS.differences,
  unclear: LIMITS.unclears,
  gap: LIMITS.gaps,
  match: LIMITS.matches,
};

/** Words an accusation is made of: a question using them is dropped (tone rules, brief §2.6). */
const ACCUSING = /\b(?:wrong|mistakes?|incorrect|errors?|false)\b/i;

/** Lowercase, whitespace collapsed: the only normalisation quotes get (brief §6.4). */
export function normaliseQuote(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether `quote` is in `text`, word for word. A quote shortened with "..." counts when each of
 * its pieces is there, in order: still nothing but the text's own words.
 */
export function quotedFrom(text: string, quote: string): boolean {
  const haystack = normaliseQuote(text);
  const pieces = normaliseQuote(quote)
    .split(/\s*(?:\.\.\.|…)\s*/)
    .filter((piece) => piece !== "");
  let from = 0;
  for (const piece of pieces) {
    const at = haystack.indexOf(piece, from);
    if (at < 0) return false;
    from = at + piece.length;
  }
  return pieces.length > 0;
}

export function validateFindings(output: NotesCompareOutput, input: ValidationInput): Validation {
  const blocks = new Map(input.blocks.map((b) => [b.blockId, b]));
  const lines = new Map(input.lines.map((l) => [l.id, l]));
  const dropped: Partial<Record<DropReason, number>> = {};
  const drop = (reason: DropReason) => {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
    return null;
  };
  let downgraded = 0;

  const checkOne = (finding: ModelFinding): CheckedFinding | null => {
    // Every id must be one the model was given.
    if (finding.blockIds.length === 0 || !finding.blockIds.every((id) => blocks.has(id))) {
      return drop("unknown_ids");
    }
    if (!finding.lineIds.every((id) => lines.has(id))) return drop("unknown_ids");

    // The screen quote must really be on the screen, in one of the blocks named.
    const screenQuote = normaliseQuote(finding.screenQuote) ? finding.screenQuote.trim() : "";
    const onScreen = finding.blockIds.some((id) =>
      quotedFrom(blocks.get(id)?.text ?? "", screenQuote),
    );
    if (!screenQuote || !onScreen) return drop("quote_not_found");

    let type = finding.type;
    let lineIds = [...new Set(finding.lineIds)];
    const noteQuote = finding.noteQuote.trim() || undefined;
    if (noteQuote) {
      const inNotes = lineIds.some((id) => quotedFrom(lines.get(id)?.text ?? "", noteQuote));
      if (!inNotes && type !== "gap") return drop("quote_not_found");
    }

    if (type === "gap") {
      // A heading on its own isn't missing knowledge; the idea under it might be.
      if (isHeading(screenQuote)) return drop("heading_gap");
      lineIds = [];
    } else if (lineIds.length === 0) {
      return drop("unknown_ids");
    }

    if (type === "difference" || type === "unclear") {
      if (!noteQuote) return drop("missing_quote");
      // A saved clip is the student's notes but never their mistake.
      lineIds = lineIds.filter((id) => lines.get(id)?.source === "ink");
      const quoteInInk = lineIds.some((id) => quotedFrom(lines.get(id)?.text ?? "", noteQuote));
      if (lineIds.length === 0 || !quoteInInk) return drop("clip_line");
    }

    if (type === "difference") {
      const unsure = lineIds.some((id) => (lines.get(id)?.confidence ?? 0) < LIMITS.lowRecognition);
      if (unsure) {
        type = "unclear";
        downgraded++;
      } else if (finding.confidence < LIMITS.differenceConfidence) {
        return drop("low_confidence");
      }
    }

    let question: string | undefined;
    if (type !== "match") {
      const checked = checkQuestion(finding.question);
      if (checked === "missing") return drop("missing_question");
      if (checked === "tone") return drop("tone");
      if (checked === "unsafe") return drop("unsafe");
      question = checked.text;
    }

    const insertAfter =
      type === "gap" &&
      finding.suggestedInsertAfterLineId &&
      lines.has(finding.suggestedInsertAfterLineId)
        ? finding.suggestedInsertAfterLineId
        : undefined;
    const conceptHint = finding.conceptHint?.trim().slice(0, LIMITS.conceptChars) || undefined;
    return {
      type,
      lineIds,
      blockIds: [...new Set(finding.blockIds)],
      ...(noteQuote && type !== "gap" && { noteQuote: noteQuote.slice(0, LIMITS.quoteChars) }),
      screenQuote: screenQuote.slice(0, LIMITS.quoteChars),
      explanation: finding.explanation.trim().slice(0, LIMITS.explanationChars),
      ...(question && { question }),
      ...(insertAfter && { insertAfter }),
      sourceConflict: type === "difference" && finding.sourceConflict === true,
      ...(conceptHint && { conceptHint }),
      ...(finding.noteMath && { noteMath: finding.noteMath }),
      ...(finding.screenMath && { screenMath: finding.screenMath }),
      confidence: finding.confidence,
      evidence: ["model"],
    };
  };

  const checked = output.findings.map(checkOne).filter((f) => f !== null);

  // A block the notes already cover can't also be missing from them.
  const covered = new Set(checked.filter((f) => f.type !== "gap").flatMap((f) => f.blockIds));
  const consistent = checked.filter((f) => {
    if (f.type !== "gap" || !f.blockIds.some((id) => covered.has(id))) return true;
    drop("inconsistent");
    return false;
  });

  const unique = new Map<string, CheckedFinding>();
  for (const finding of consistent) {
    const key = `${finding.type}|${[...finding.lineIds].sort().join()}|${[...finding.blockIds].sort().join()}`;
    const other = unique.get(key);
    if (other) drop("duplicate");
    if (!other || finding.confidence > other.confidence) unique.set(key, finding);
  }

  const findings = capByType([...unique.values()], () => drop("over_cap"));
  return { findings, dropped, downgraded };
}

/** A couple of plain words ("Mountains", "Cognitive development"): a title, not an idea. Short
 * formulas and values ("O(log n)", "pH 7") have digits or symbols and aren't headings. */
function isHeading(quote: string): boolean {
  return quote.trim().split(/\s+/).length < 3 && !/[\d=<>+\-*/^()×÷±√π%°]/.test(quote);
}

/** The question, made safe and gentle, or why it can't be used. */
function checkQuestion(
  question: string | undefined,
): { text: string } | "missing" | "tone" | "unsafe" {
  const text = question?.replace(/!/g, ".").replace(/\s+/g, " ").trim();
  if (!text) return "missing";
  if (ACCUSING.test(text)) return "tone";
  if (unsafeReasons(text).length > 0) return "unsafe";
  if (text.length > LIMITS.questionChars || text.split(" ").length > LIMITS.questionWords) {
    return "missing";
  }
  return { text };
}

/**
 * The finding as a match (its claim turned out to agree with the screen): no question, no
 * conflict, with the evidence that showed it.
 */
export function asMatch(finding: CheckedFinding, evidence: FindingEvidence): CheckedFinding {
  return {
    type: "match",
    lineIds: finding.lineIds,
    blockIds: finding.blockIds,
    ...(finding.noteQuote && { noteQuote: finding.noteQuote }),
    screenQuote: finding.screenQuote,
    explanation: finding.explanation,
    sourceConflict: false,
    ...(finding.conceptHint && { conceptHint: finding.conceptHint }),
    ...(finding.noteMath && { noteMath: finding.noteMath }),
    ...(finding.screenMath && { screenMath: finding.screenMath }),
    confidence: finding.confidence,
    evidence: [...finding.evidence, evidence],
  };
}

/** Keeps the most confident findings of each type, within the caps; differences first. */
export function capByType(
  findings: CheckedFinding[],
  onDrop: () => void = () => undefined,
): CheckedFinding[] {
  const order: FindingType[] = ["difference", "unclear", "gap", "match"];
  return order.flatMap((type) => {
    const ofType = findings
      .filter((f) => f.type === type)
      .sort((a, b) => b.confidence - a.confidence);
    ofType.slice(CAPS[type]).forEach(onDrop);
    return ofType.slice(0, CAPS[type]);
  });
}

// ─── Speech ─────────────────────────────────────────────────────────────────────────────────

/** The model's summary, if it can be said as it is: safe, gentle, short. Otherwise null. */
export function usableSpeech(speech: string): string | null {
  const text = speech.replace(/!/g, ".").replace(/\s+/g, " ").trim();
  if (!text || ACCUSING.test(text) || unsafeReasons(text).length > 0) return null;
  const sentences = text.split(/(?<=[.?])\s+/).filter(Boolean);
  if (sentences.length > 2 || text.length > LIMITS.speechChars) return null;
  return text;
}

/**
 * Whether the summary still describes the findings: the same differences, gaps and unclears
 * (by type and line) as the model reported. If validation changed them, the summary is rebuilt.
 */
export function sameNotableFindings(
  before: readonly Pick<ModelFinding, "type" | "lineIds" | "blockIds">[],
  after: readonly Pick<CheckedFinding, "type" | "lineIds" | "blockIds">[],
): boolean {
  const key = (f: { type: string; lineIds: readonly string[]; blockIds: readonly string[] }) =>
    `${f.type}|${[...f.lineIds].sort().join()}|${[...f.blockIds].sort().join()}`;
  const notable = (
    list: readonly { type: string; lineIds: readonly string[]; blockIds: readonly string[] }[],
  ) =>
    list
      .filter((f) => f.type !== "match")
      .map(key)
      .sort()
      .join(";");
  return notable(before) === notable(after);
}

/** A short summary built from the findings themselves (brief §6.6): never a list read out. */
export function summarySpeech(findings: readonly CheckedFinding[]): string {
  const count = (type: FindingType) => findings.filter((f) => f.type === type).length;
  const differences = count("difference");
  const unclears = count("unclear");
  const gaps = findings.filter((f) => f.type === "gap");
  const matches = count("match");

  const opening =
    matches > 0
      ? differences + unclears + gaps.length > 0
        ? "Most of this matches your notes."
        : "This matches your notes. You've got it."
      : "";
  const asks: string[] = [];
  if (differences === 1) asks.push("there's one line I'd like you to look at again");
  if (differences > 1) asks.push(`there are ${differences} lines I'd like you to look at again`);
  if (unclears > 0 && differences === 0)
    asks.push("I couldn't quite read one of your lines, so let's check it together");
  const gap = gaps[0];
  if (gap) {
    const what = gap.conceptHint ? `covers ${gap.conceptHint.toLowerCase()}` : "covers something";
    asks.push(`the screen ${what} that your notes don't have yet`);
  }
  if (asks.length === 0) return opening || "I couldn't match this to your notes.";
  const second = asks.slice(0, 2).join(", and ");
  const sentence = `${second.charAt(0).toUpperCase()}${second.slice(1)}.`;
  return opening ? `${opening} ${sentence}` : sentence;
}

/** What's said when nothing in the notes relates to the screen (brief §5.3). */
export const NO_RELATED_NOTES_SPEECH =
  "I couldn't find notes on this yet. Want to start a page for it?";
