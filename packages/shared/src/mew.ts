import { z } from "zod";

/** Size caps keep gate requests small and cheap; the client trims before sending. */
export const MEW_LIMITS = {
  utteranceChars: 500,
  transcriptSegments: 6,
  regionTextChars: 500,
  reasonChars: 200,
  /** "Physics chapter 5": where the student said to save something (K3). */
  destinationChars: 160,
} as const;

export const MewLabel = z.enum([
  "ignore",
  "answer_question",
  "check_work",
  "give_hint",
  "complete_step",
  "draw_visual",
  /** "Save it to my Physics notebook, chapter 5" (K3): not a tutor turn. */
  "save_to_notebook",
  /** Create, rename or move a notebook or chapter by voice (K3; never delete). */
  "notebook_command",
  /** "Just give me the answer" (K6: every step with its reason, then a Your Turn). */
  "show_full_solution",
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
  /**
   * Where the student said to save something, as they said it ("chem ch 2"), with or without a
   * question in the same breath (K3 §4.5): one call, never a second one to split them.
   */
  destinationPhrase: z.string().trim().min(1).max(MEW_LIMITS.destinationChars).optional(),
});
export type MewOutput = z.infer<typeof MewOutput>;

/** Response of `POST /api/mew`. */
export const MewDecisionResponse = z.object({
  output: MewOutput,
  /**
   * "model" = classified by the gate model; "rule" = decided locally without a model call;
   * "checker" = a verifier (SymPy, chemistry balance, code run) found a definite answer first;
   * "local" = Mew v2, the classifier running in the browser (M10).
   */
  source: z.enum(["model", "rule", "fallback", "checker", "local"]),
  latencyMs: z.number().int().nonnegative(),
});
export type MewDecisionResponse = z.infer<typeof MewDecisionResponse>;
