import type { MewInput } from "./mew";

/**
 * Mew v2 (M10): a gate input as one line of text for the classifier. Training (Python:
 * backend/src/mew_api/dataset/features.py) and the in-browser model must build exactly the same
 * text, so both implementations are checked against mew-features.cases.json.
 *
 * The utterance comes first (it matters most, and survives truncation); the notebook signals
 * are bucketed into words so the model sees "just now" rather than raw milliseconds.
 */
export const MEW_FEATURES_VERSION = "mew-features.v1";

const UTTERANCE_CHARS = 300;
const CONTEXT_CHARS = 150;
const CONTEXT_SEGMENTS = 2;

export function mewFeatureText(input: MewInput): string {
  const signals = input.notebookSignals;
  const parts = [
    tail(input.lastUtterance, UTTERANCE_CHARS) || "(nothing said)",
    `before: ${
      input.recentTranscript
        .slice(-CONTEXT_SEGMENTS)
        .map((s) => tail(s, CONTEXT_CHARS))
        .filter(Boolean)
        .join(" / ") || "-"
    }`,
    `writing: ${tail(signals.activeRegionText ?? "", CONTEXT_CHARS) || "-"}`,
    [
      `trigger ${input.trigger.replace("_", " ")}`,
      `summoned ${yes(input.explicitSummon)}`,
      `tutor spoke ${yes(input.tutorSpokeRecently)}`,
      `last stroke ${strokeBucket(signals.msSinceLastStroke)}`,
      `erased ${yes(signals.justErased)}`,
      `lines ${signals.linesWrittenLast60s >= 3 ? "3+" : signals.linesWrittenLast60s}`,
    ].join("; "),
  ];
  return parts.join(" | ");
}

/** The last `max` characters, whitespace collapsed. Counts code points, as Python does. */
function tail(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= max ? chars.join("") : chars.slice(-max).join("").trimStart();
}

const yes = (value: boolean) => (value ? "yes" : "no");

function strokeBucket(ms: number | null): string {
  if (ms === null) return "none";
  if (ms < 2_000) return "just now";
  if (ms < 10_000) return "seconds ago";
  if (ms < 60_000) return "a minute ago";
  return "a while ago";
}
