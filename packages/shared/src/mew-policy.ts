import type { MewInput, MewOutput } from "./mew";

/** Minimum gate confidence to act on (user-adjustable in settings). */
export const DEFAULT_MEW_THRESHOLD = 0.7;
/** After the tutor finishes, stay quiet this long unless the student asks something new. */
export const MEW_COOLDOWN_MS = 4000;
/** Writing followed by this much stillness counts as a pause worth checking. */
export const PEN_PAUSE_MS = 1500;

const FILLER = new Set([
  "ah",
  "alright",
  "and",
  "erm",
  "hm",
  "hmm",
  "huh",
  "like",
  "mm",
  "mhm",
  "no",
  "now",
  "oh",
  "ok",
  "okay",
  "right",
  "so",
  "then",
  "uh",
  "um",
  "well",
  "wait",
  "yeah",
  "yes",
  "yep",
]);

/** Lowercase words without punctuation. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Decides obvious cases without a model call: empty speech and short filler ("hmm", "okay so")
 * are ignored. Returns null when the model should decide. Never short-circuits a summon.
 */
export function prefilterMew(input: MewInput): MewOutput | null {
  if (input.explicitSummon || input.trigger !== "utterance") return null;
  const tokens = words(input.lastUtterance);
  if (tokens.length === 0) return { label: "ignore", confidence: 1, reason: "no speech" };
  if (tokens.length <= 4 && tokens.every((t) => FILLER.has(t))) {
    return { label: "ignore", confidence: 0.95, reason: "filler only" };
  }
  return null;
}

const WAKE_PHRASE =
  /^(.*?)\b(?:hey|hi|hello|okay|ok)[\s,!.]+(?:mew|mu|mue|meow|miu|mieu|myu|mewl)\b[\s,!.?]*(.*)$/is;

/**
 * Detects "Hey Mew" (and common mis-transcriptions) anywhere in an utterance. `request` is what
 * follows the wake phrase (or what preceded it, if nothing follows).
 */
export function detectWakePhrase(text: string): { summoned: boolean; request: string } {
  const match = WAKE_PHRASE.exec(text);
  if (!match) return { summoned: false, request: text };
  const before = (match[1] ?? "").trim();
  const after = (match[2] ?? "").trim();
  return { summoned: true, request: after || before };
}

const QUESTION_START =
  /^(why|what|how|when|where|which|who|whose|can|could|would|should|is|are|was|were|do|does|did|will|explain|show|tell)\b/i;

/** Whether an utterance looks like a fresh question or request (used to break the cooldown). */
export function isNewQuestion(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.endsWith("?") || QUESTION_START.test(trimmed);
}

/** Applies the decision policy to a gate classification. */
export function shouldRespond(
  output: MewOutput,
  { threshold, explicitSummon }: { threshold: number; explicitSummon: boolean },
): boolean {
  if (output.label === "ignore") return false;
  return explicitSummon || output.confidence >= threshold;
}

/**
 * Post-processes a model classification so hard rules hold regardless of what the model said:
 * a summon is never ignored.
 */
export function enforceMewRules(input: MewInput, output: MewOutput): MewOutput {
  if (input.explicitSummon && output.label === "ignore") {
    return { label: "answer_question", confidence: 0.5, reason: "summoned; no clearer request" };
  }
  return output;
}

/** What to do when the gate can't be reached: stay silent, unless the student summoned Mew. */
export function fallbackMew(input: MewInput): MewOutput {
  return input.explicitSummon
    ? { label: "answer_question", confidence: 0.5, reason: "gate unavailable; summoned" }
    : { label: "ignore", confidence: 0, reason: "gate unavailable" };
}
