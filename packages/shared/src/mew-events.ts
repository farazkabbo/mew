import { z } from "zod";

import { MewDecisionResponse, MewInput, MewLabel } from "./mew";

/**
 * Mew v2 (M10): gate decisions kept (with the student's opt-in) so they can be labelled and used
 * to train the in-browser gate. Mirrors backend/src/mew_api/mew_events/models.py.
 */

/** Logging one decision: what the gate saw and what it decided (and how). */
export const MewEventCreate = z
  .object({
    input: MewInput,
    output: MewDecisionResponse.shape.output,
    source: MewDecisionResponse.shape.source,
    latencyMs: z.number().int().min(0).max(120_000),
  })
  .strict();
export type MewEventCreate = z.infer<typeof MewEventCreate>;

export const MewEvent = z.object({
  id: z.uuid(),
  input: MewInput,
  output: z.object({
    label: MewLabel,
    confidence: z.number(),
    reason: z.string(),
    source: z.string().optional(),
    latencyMs: z.number().optional(),
  }),
  human_label: MewLabel.nullable(),
  created_at: z.string(),
});
export type MewEvent = z.infer<typeof MewEvent>;

export const MewEventPage = z.object({ events: z.array(MewEvent) });
export type MewEventPage = z.infer<typeof MewEventPage>;

export const LabelUpdate = z.object({ human_label: MewLabel.nullable() }).strict();
export type LabelUpdate = z.infer<typeof LabelUpdate>;

export const MEW_LABEL_NAMES: Record<MewLabel, string> = {
  ignore: "Stay quiet",
  answer_question: "Answer",
  check_work: "Check work",
  give_hint: "Give a hint",
  complete_step: "Next step",
  draw_visual: "Draw",
};
