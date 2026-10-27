import "server-only";

import {
  advance,
  COACH_LIMITS,
  COACH_PLANNER_PROMPT,
  COACH_VERIFIER_PROMPT,
  CoachPlan,
  type CoachInput,
  type CoachRecheckRequest,
  type CoachReply,
  type CoachResumeRequest,
  type CoachStartRequest,
  type CoachStepRequest,
  CoachVerdict,
  coachPlanReasons,
  coachVerdictReasons,
  declined,
  pickSkill,
  recheckSteps,
  renderPlannerInput,
  type SkillEvidence,
  skillKey,
  renderVerifierInput,
  type ScreenImage,
  standing,
  started,
  stepsOf,
  type StepVerdict,
  unsafeReasons,
  type Walkthrough,
  type WalkthroughContext,
  walkthroughEvidence,
} from "@mew/shared";
import type { z } from "zod";

import { screenModel, verifierModel } from "../env";
import { type GenerateStructured, generateStructured, ModelBusyError } from "../gemini";
import { HttpError } from "../http-error";
import { review } from "../learner";
import type { WalkthroughStore } from "./store";

/**
 * Coach mode on the server (Screen Coach S4, decision 10): the planner plans a walkthrough, the
 * verifier checks each step, the state machine (`advance`, in @mew/shared) decides what happens
 * and what's said, and the walkthrough is stored by the API service after every event.
 *
 * Screenshots are only forwarded to the models (`store: false`), never kept. Every text the
 * models write passes the rule-based safety check before it can be said or shown (decision 3).
 */

const PLAN_TIMEOUT_MS = 25_000;
const CHECK_TIMEOUT_MS = 12_000;

export const COACH_MESSAGES = {
  /** The planner wrote something the safety check blocks: no walkthrough at all. */
  refused: "I can't guide you through that one, but I can explain what's on your screen.",
  nothingToResume:
    "There's no walkthrough to continue. Ask me to teach you something, like how to make a chart.",
  checkFailed: "I couldn't check that just now. Press Done again in a moment.",
  /** The final speech failed the safety check (shouldn't happen: its parts were checked). */
  carryOn: "Have a look at the step, then press Done.",
  /** S5: nothing learned yet to re-check. */
  noSkills: "You haven't learned anything with me yet. Ask me to teach you something first.",
  /** S5: starting a re-check. */
  recheck: "Let's see if you can do it without me.",
} as const;

/** S5: what's said once the skill is recorded, after "You did it with 1 hint." */
export const SKILL_SPEECH: Record<SkillEvidence, string> = {
  independent: "On your own, too. That's in your skills.",
  with_hint: "Saved to your skills. I'll ask you to try it on your own in a few days.",
  after_explanation: "Saved to your skills. We'll try it again soon, a bit more on your own.",
  not_yet: "",
};

export type CoachDeps = {
  generate: GenerateStructured;
  store: WalkthroughStore;
  now: () => Date;
};

type Scene = {
  app: string | null;
  scope: "window" | "monitor";
  image: z.infer<typeof ScreenImage>;
};

/** "Teach me how to…": plans the walkthrough and shows step 1, or says why it can't. */
export async function startCoaching(
  request: CoachStartRequest,
  deps: CoachDeps,
  signal?: AbortSignal,
): Promise<CoachReply> {
  const plan = await deps.generate({
    model: screenModel(),
    system: COACH_PLANNER_PROMPT.system,
    input: [
      { type: "text", text: renderPlannerInput(request) },
      { type: "image", base64: request.image.jpeg, mimeType: "image/jpeg" },
    ],
    schema: CoachPlan,
    thinkingLevel: "low",
    maxOutputTokens: 4096,
    timeoutMs: PLAN_TIMEOUT_MS,
    ...(signal && { signal }),
  });
  const blocked = coachPlanReasons(plan);
  if (blocked.length > 0) {
    // Counts only: never what was asked or planned.
    console.info(`[coach] safety check refused a plan (${blocked.join(", ")})`);
    return declined({ title: "", intro: COACH_MESSAGES.refused });
  }
  if (!plan.feasible || plan.steps.length === 0) return declined(plan);

  const walkthrough = await deps.store.create({
    title: plan.title,
    goal: clip(request.goal, COACH_LIMITS.goalChars),
    app: request.app,
    steps: stepsOf(plan),
  });
  console.info(`[coach] started a walkthrough (${walkthrough.steps.length} steps)`);
  return started(walkthrough, plan.intro, plan.firstTarget);
}

/** "Continue where we left off": the latest unfinished walkthrough, checked on this screen. */
export async function resumeCoaching(
  request: CoachResumeRequest,
  deps: CoachDeps,
  signal?: AbortSignal,
): Promise<CoachReply> {
  const walkthrough = await deps.store.latest();
  if (!walkthrough) return declined({ title: "", intro: COACH_MESSAGES.nothingToResume });
  return checkThenAdvance(walkthrough, "resume", request, deps, signal);
}

/**
 * "Let me try pivot tables on my own" (S5 §6: "do it without me, tell me when done", then
 * verify): a re-check of the skill named (or the most overdue one), the whole task as one step,
 * with no arrow. Done without hints, it's the only way a skill becomes `independent`.
 */
export async function recheckCoaching(
  request: CoachRecheckRequest,
  deps: CoachDeps,
): Promise<CoachReply> {
  const skills = await deps.store.skills();
  const skill = pickSkill(skills, request.words, request.app);
  const taught = skill?.lastWalkthroughId ? await deps.store.get(skill.lastWalkthroughId) : null;
  const steps = skill && taught ? recheckSteps(skill.title, taught.steps) : [];
  if (!skill || steps.length === 0) return declined({ title: "", intro: COACH_MESSAGES.noSkills });
  const walkthrough = await deps.store.create({
    title: skill.title,
    goal: clip(`Try ${skill.title} on my own`, COACH_LIMITS.goalChars),
    app: request.app ?? skill.app,
    steps,
    kind: "recheck",
    skillId: skill.id,
  });
  console.info("[coach] started a re-check");
  return started(walkthrough, COACH_MESSAGES.recheck, null);
}

/** Something happened in a walkthrough: a check ("done", "I'm stuck"), a "yes", pause or stop. */
export async function stepCoaching(
  request: CoachStepRequest,
  deps: CoachDeps,
  signal?: AbortSignal,
): Promise<CoachReply> {
  const walkthrough = await deps.store.get(request.walkthroughId);
  if (!walkthrough) throw new HttpError(404, "Not found");
  switch (request.event) {
    case "done":
    case "stuck":
      return checkThenAdvance(walkthrough, request.event, request, deps, signal);
    case "yes":
      return commit(walkthrough, { kind: "confirmed" }, deps);
    case "pause":
    case "stop":
      return commit(walkthrough, { kind: request.event }, deps);
  }
}

/** The walkthrough's title and current step, for a question asked in the middle of it. */
export async function walkthroughContext(
  store: WalkthroughStore,
  id: string,
): Promise<WalkthroughContext | undefined> {
  const walkthrough = await store.get(id).catch(() => null);
  const step = walkthrough?.steps[walkthrough.current];
  if (!walkthrough || !step || walkthrough.status !== "active") return undefined;
  return { title: walkthrough.title, step: walkthrough.current + 1, instruction: step.instruction };
}

async function checkThenAdvance(
  walkthrough: Walkthrough,
  reason: "done" | "stuck" | "resume",
  scene: Scene,
  deps: CoachDeps,
  signal?: AbortSignal,
): Promise<CoachReply> {
  let verdict: StepVerdict;
  try {
    verdict = await verify(walkthrough, scene, deps.generate, signal);
  } catch (error) {
    if (signal?.aborted || error instanceof ModelBusyError) throw error;
    console.warn("[coach] check failed:", error instanceof Error ? error.name : "error");
    // Nothing changes: the student can simply try again.
    return standing(walkthrough, COACH_MESSAGES.checkFailed);
  }
  return commit(walkthrough, { kind: "checked", reason, verdict }, deps);
}

/** One verifier call. Unsafe words (a redirect, the control's name) are dropped, not the check. */
async function verify(
  walkthrough: Walkthrough,
  scene: Scene,
  generate: GenerateStructured,
  signal?: AbortSignal,
): Promise<StepVerdict> {
  const verdict = await generate({
    model: verifierModel(),
    system: COACH_VERIFIER_PROMPT.system,
    input: [
      {
        type: "text",
        text: renderVerifierInput(walkthrough, {
          app: scene.app,
          scope: scene.scope,
          width: scene.image.width,
          height: scene.image.height,
        }),
      },
      { type: "image", base64: scene.image.jpeg, mimeType: "image/jpeg" },
    ],
    schema: CoachVerdict,
    thinkingLevel: "low",
    maxOutputTokens: 1024,
    timeoutMs: CHECK_TIMEOUT_MS,
    ...(signal && { signal }),
  });
  // The observation goes no further: never stored, said or logged.
  const { status, confidence, redirect, target } = verdict;
  const blocked = coachVerdictReasons(verdict);
  if (blocked.length === 0) return { status, confidence, redirect, target };
  console.info(`[coach] safety check dropped a check's words (${blocked.join(", ")})`);
  return { status, confidence, redirect: null, target: target && { point: target.point } };
}

/** Runs the state machine and stores the result (unless nothing changed). */
async function commit(
  walkthrough: Walkthrough,
  input: CoachInput,
  deps: CoachDeps,
): Promise<CoachReply> {
  const { walkthrough: next, reply } = advance(walkthrough, input, deps.now().toISOString());
  if (next !== walkthrough) {
    const saved = await deps.store.update(walkthrough.id, {
      revision: walkthrough.revision,
      status: next.status,
      phase: next.phase,
      current: next.current,
      steps: next.steps,
    });
    // Another event (the pill and the voice at once) moved it on first: that one stands.
    if (!saved) throw new HttpError(409, "The walkthrough has moved on");
  }
  if (unsafeReasons(reply.speech).length > 0) return { ...reply, speech: COACH_MESSAGES.carryOn };
  if (next.status === "completed" && walkthrough.status !== "completed") {
    const learned = await learnSkill(next, deps).catch(() => null);
    if (learned) return { ...reply, speech: `${reply.speech} ${SKILL_SPEECH[learned]}`.trim() };
  }
  return reply;
}

/**
 * S5 §6: a finished walkthrough becomes (or re-checks) a skill: its evidence by the brief's rule
 * (guided is never independent), its card rescheduled by FSRS here, and both stored by the API
 * service, which checks the rule again. Best effort: the walkthrough is finished either way.
 */
async function learnSkill(
  walkthrough: Walkthrough,
  deps: CoachDeps,
): Promise<SkillEvidence | null> {
  const evidence = walkthroughEvidence(walkthrough);
  if (!evidence) return null;
  const skills = await deps.store.skills();
  const key = skillKey(walkthrough.title, walkthrough.app);
  const known =
    skills.find((s) => s.id === walkthrough.skillId) ??
    skills.find((s) => skillKey(s.title, s.app) === key);
  const now = deps.now();
  const card = review(
    known?.fsrsState ?? null,
    {
      correct: evidence !== "not_yet",
      evidence: evidence === "not_yet" ? "independent" : evidence,
    },
    now,
  );
  await deps.store.recordSkill({
    walkthroughId: walkthrough.id,
    // A re-check keeps its skill's own name and app.
    title: known?.title ?? walkthrough.title,
    app: known ? known.app : walkthrough.app,
    kind: walkthrough.kind,
    evidence,
    hints: hintsUsedBy(walkthrough),
    card,
    dueAt: card.due,
  });
  console.info(`[coach] recorded a skill (${walkthrough.kind}, ${evidence})`);
  return evidence;
}

const hintsUsedBy = (walkthrough: Walkthrough) =>
  walkthrough.steps.reduce((sum, step) => sum + step.hints, 0);

/** At most `max` characters, cut at a word. */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1));
}

export const defaultCoachDeps = (store: WalkthroughStore): CoachDeps => ({
  generate: generateStructured,
  store,
  now: () => new Date(),
});
