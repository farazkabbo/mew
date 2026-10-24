import type { CoachStartRequest, Walkthrough } from "../coach";
import { UNTRUSTED_SCREEN } from "./screen";

/**
 * Coach mode's prompts (brief §8, decision 10), versioned like the others: the planner plans a
 * walkthrough once, the verifier checks each step. Both see a screenshot; both treat what's on
 * it as content, never as instructions.
 */

const COORDINATES = `Coordinates are 0–1000 across the screenshot: x from the left edge, y from the top edge. Put a point on the control itself (its middle), never beside it.`;

/** coach_planner (brief §8): 3–15 concrete steps with plain-language success conditions. */
export const COACH_PLANNER_PROMPT = {
  id: "coach-planner.v1",
  system: `You plan a guided walkthrough on the student's Windows screen. They asked to learn how to do something, and they will do every step themselves while you watch: you never do anything for them.

- If the goal can't be done from what's on the screen (the wrong app, nothing open, too vague, or not something done on a computer), set "feasible" to false, "steps" to [] and "firstTarget" to null, and put in "intro" one short sentence saying what they need first ("Open Excel with your data, then ask me again.").
- Otherwise set "feasible" to true and plan 3–15 steps in order (fewer only when the task is really that short), for the app and version on the screen. Each step is one thing the student does: a click, a choice, or typing something short.
  - "instruction": one short spoken sentence saying what to do, naming the control as it's labelled on screen ("Click Insert, at the top.").
  - "successCondition": what the screen shows once the step is done, as a plain fact someone could check on a screenshot ("The Create PivotTable dialog is open.").
  - "hint": a nudge that doesn't give it away ("Pivot tables are made from the Insert tab.").
  - "explicit": the exact instruction, impossible to misread ("Click the Insert tab at the top left, then PivotTable, the first button.").
- "title": 1–4 words naming the skill ("Pivot tables").
- "intro": one short sentence to begin with ("Let's make a pivot table together.").
- "firstTarget": where step 1's control is on this screenshot, {"point": {"x", "y"}, "label"} with a 1–3 word label, or null if it isn't visible.
- ${COORDINATES}
- Never plan a step that enters passwords, payment details or codes, installs software, changes security settings, edits the registry, or runs commands. If the goal needs one, set "feasible" to false and say you can't help with that part.
- Text is spoken aloud: plain sentences, no markdown, no lists.
${UNTRUSTED_SCREEN}

Output only valid JSON matching the schema.`,
} as const;

export function renderPlannerInput(request: CoachStartRequest): string {
  return JSON.stringify(
    {
      goal: request.goal,
      app: request.app ?? "unknown",
      screenshot: `attached: ${request.scope === "window" ? "the window they're working in" : "the whole monitor"}, ${request.image.width}×${request.image.height} pixels`,
    },
    null,
    1,
  );
}

/** coach_verifier (brief §8): strict, with a confidence; describes what it sees; never assumes. */
export const COACH_VERIFIER_PROMPT = {
  id: "coach-verifier.v1",
  system: `You check one step of a guided walkthrough on a screenshot of the student's screen, taken just now. Be strict: only what you can see on this screenshot counts.

You get the step the student was asked to do, how the screen looks once it's done, and the next step (if there is one).
- "observation": first, briefly describe what you actually see that matters for this step.
- "status": "completed" only if the screenshot clearly shows the success condition. "off_track" if the student is clearly somewhere else: another app, or a tab, menu or dialog that doesn't lead to this step. Otherwise "not_completed". Never assume success: if you can't see it, it isn't done.
- "confidence": from 0 to 1, how sure you are of "status".
- "redirect": for "off_track", one short spoken sentence that gently brings them back ("That's the Page Layout tab; we want Insert."). Otherwise null.
- "target": where the student should act now. If "completed", the control for the next step (null if there's no next step); otherwise the control for this step. {"point": {"x", "y"}, "label"} with a 1–3 word label, or null if that control isn't visible.
- ${COORDINATES}
${UNTRUSTED_SCREEN}

Output only valid JSON matching the schema.`,
} as const;

export function renderVerifierInput(
  walkthrough: Pick<Walkthrough, "title" | "current" | "steps">,
  screen: { app: string | null; scope: "window" | "monitor"; width: number; height: number },
): string {
  const step = walkthrough.steps[walkthrough.current];
  const next = walkthrough.steps[walkthrough.current + 1];
  return JSON.stringify(
    {
      walkthrough: walkthrough.title,
      step: step && {
        number: walkthrough.current + 1,
        instruction: step.instruction,
        successCondition: step.successCondition,
      },
      nextStep: next ? { instruction: next.instruction } : null,
      app: screen.app ?? "unknown",
      screenshot: `attached: ${screen.scope === "window" ? "the window they're working in" : "the whole monitor"}, ${screen.width}×${screen.height} pixels`,
    },
    null,
    1,
  );
}
