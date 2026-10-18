import { z } from "zod";

/** Size caps keep gate requests small and cheap; the client trims before sending. */
export const MEW_LIMITS = {
  utteranceChars: 500,
  transcriptSegments: 6,
  regionTextChars: 500,
  reasonChars: 200,
} as const;

export const MewLabel = z.enum([
  "ignore",
  "answer_question",
  "check_work",
  "give_hint",
  "complete_step",
  "draw_visual",
]);
export type MewLabel = z.infer<typeof MewLabel>;

export const NotebookSignals = z.object({
  msSinceLastStroke: z.number().int().nonnegative().nullable(),
  justErased: z.boolean(),
  linesWrittenLast60s: z.number().int().nonnegative().max(1000),
  /** Recognised text of the line being written, when available (M3+). */
  activeRegionText: z.string().max(MEW_LIMITS.regionTextChars).optional(),
});
export type NotebookSignals = z.infer<typeof NotebookSignals>;

export const MewTrigger = z.enum(["utterance", "pen_pause", "summon"]);
export type MewTrigger = z.infer<typeof MewTrigger>;

export const MewInput = z.object({
  trigger: MewTrigger,
  lastUtterance: z.string().max(MEW_LIMITS.utteranceChars),
  recentTranscript: z
    .array(z.string().max(MEW_LIMITS.utteranceChars))
    .max(MEW_LIMITS.transcriptSegments),
  notebookSignals: NotebookSignals,
  tutorSpokeRecently: z.boolean(),
  explicitSummon: z.boolean(),
});
export type MewInput = z.infer<typeof MewInput>;

/** What the gate model returns. */
export const MewOutput = z.object({
  label: MewLabel,
  confidence: z.number().min(0).max(1),
  reason: z.string().max(MEW_LIMITS.reasonChars),
});
export type MewOutput = z.infer<typeof MewOutput>;

/** Response of `POST /api/mew`. */
export const MewDecisionResponse = z.object({
  output: MewOutput,
  /**
   * "model" = classified by the gate model; "rule" = decided locally without a model call;
   * "checker" = a verifier (SymPy, chemistry balance, code run) found a definite answer first.
   */
  source: z.enum(["model", "rule", "fallback", "checker"]),
  latencyMs: z.number().int().nonnegative(),
});
export type MewDecisionResponse = z.infer<typeof MewDecisionResponse>;
