import { z } from "zod";

import { ShortcutBindings } from "./shortcuts";

/**
 * Per-user settings (M9), stored in profiles.settings. Mirrors
 * backend/src/mew_api/profiles/models.py; keys are snake_case as stored.
 */

export const VoiceId = z.string().regex(/^[A-Za-z0-9]{8,64}$/);

export const UserSettings = z.object({
  mew_threshold: z.number().min(0.3).max(0.95),
  answer_style: z.enum(["hints_first", "direct"]),
  captions: z.boolean(),
  /** Check each finished line quietly after a writing pause. */
  auto_check: z.boolean(),
  /** Start listening when a notebook opens. */
  listen_on_open: z.boolean(),
  /** null: the server's default voice. */
  voice_id: VoiceId.nullable(),
  /** Keep Mew's decisions (with what was said) so they can be labelled to improve Mew (M10). */
  mew_logging_opt_in: z.boolean(),
  /**
   * Notes Check keeps a searchable copy of the notes' text on the server (S3.5 decision 2).
   * Turning it off deletes that copy.
   */
  notes_index: z.boolean(),
  /** The first-run introduction has been seen. */
  onboarded: z.boolean(),
  /** The student's own keyboard shortcuts (K2: two keys at most; the rest keep the defaults). */
  shortcuts: ShortcutBindings,
  /** The one-time "Shortcuts got simpler" card was read (K2; new students never see it). */
  shortcuts_notice_seen: z.boolean(),
  /** After a full solution, a similar problem to do alone (K6 §6.5: "give me a Your Turn"). */
  your_turn_after_solution: z.boolean(),
  /** Every saved screen moment brings a check question back later (K8 §4.7, default on). */
  quiz_saved_moments: z.boolean(),
  /** A Windows notification when saved moments' checks are due (K8 §4.7: opt-in, default off). */
  notify_moment_checks: z.boolean(),
  /**
   * neb learns this student's handwriting from their corrections and calibration (K10 §8.3,
   * default on). Turning it off deletes what it learned.
   */
  learn_handwriting: z.boolean(),
});
export type UserSettings = z.infer<typeof UserSettings>;

export const DEFAULT_SETTINGS: UserSettings = {
  mew_threshold: 0.7,
  answer_style: "hints_first",
  captions: true,
  auto_check: true,
  listen_on_open: false,
  voice_id: null,
  mew_logging_opt_in: false,
  notes_index: true,
  onboarded: false,
  shortcuts: {},
  shortcuts_notice_seen: false,
  your_turn_after_solution: true,
  quiz_saved_moments: true,
  notify_moment_checks: false,
  learn_handwriting: true,
};

export const SettingsPatch = UserSettings.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const Voice = z.object({ id: VoiceId, name: z.string().max(40) });
export type Voice = z.infer<typeof Voice>;
export const VoiceList = z.object({ voices: z.array(Voice) });
