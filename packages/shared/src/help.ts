import { z } from "zod";

/**
 * How much Screen Coach gives away (the island's mode switch). The first three match the
 * notebook's marking levels (Quiet, Hint, Coach); Answer gives the worked answer itself, written
 * on the screen, with why each step is done and how it gets there.
 */
export const HelpLevel = z.enum(["quiet", "hint", "coach", "answer"]);
export type HelpLevel = z.infer<typeof HelpLevel>;
export const DEFAULT_HELP_LEVEL: HelpLevel = "hint";

export const HELP_LEVEL_LABELS: Record<HelpLevel, string> = {
  quiet: "Quiet",
  hint: "Hint",
  coach: "Coach",
  answer: "Answer",
};

/** What each level tells the model (put in the input as "help"). */
export const HELP_LEVEL_RULES: Record<HelpLevel, string> = {
  quiet:
    "quiet: say as little as possible. Confirm what's right, or point at where to look in a few words. No working, no answer.",
  hint: "hint: give a hint or the first step only, never the whole answer.",
  coach:
    "coach: guide them to do it themselves. Ask one leading question or give the next small step, and point at what to use. Never the whole answer.",
  answer:
    "answer: give the full answer. Write the worked solution on the screen step by step, and for each step say why it's done and how it gets to the next line. End with the final answer.",
};

/** The prompt's rule about "help": how much to give away at each level. */
export const HELP_RULE = `- "help" says how much to give away; follow it over anything else about hints and answers:
  - ${HELP_LEVEL_RULES.quiet}
  - ${HELP_LEVEL_RULES.hint}
  - ${HELP_LEVEL_RULES.coach}
  - ${HELP_LEVEL_RULES.answer}
  When "help" is missing, it's "hint".`;
