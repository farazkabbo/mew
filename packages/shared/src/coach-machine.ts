import {
  COACH_LIMITS,
  type CoachPlan,
  type CoachReply,
  type CoachVerdict,
  type ScreenTarget,
  type Walkthrough,
  type WalkthroughStep,
} from "./coach";
import { SCREEN_LIMITS, type TutorScreenAction } from "./screen";

/**
 * Coach mode's state machine (brief §5, decision 10). Pure: the server feeds it the plan, each
 * verdict and each of the student's choices, and stores what it returns. Nothing here calls a
 * model or knows about HTTP.
 *
 * Between requests a walkthrough is always waiting for the student: `awaiting` (doing the step)
 * or `confirming` (asked whether it's done). The brief's other states (planning, showing a
 * step, verifying, hinting) happen inside one request.
 *
 *   start ──► awaiting ──done──► check ─┬─ done (sure) ──────► next step, or completed
 *               ▲   ▲                   ├─ not sure ─────────► confirming ─yes─► next step
 *               │   │                   ├─ not done (sure) ──► hint ────┐   └─stuck─► hint
 *               │   └── stuck ─► check ─┤  off track (sure) ─► redirect─┤
 *               │                       └─ 4th miss ─────────► paused   │
 *               └───────────────────────────────────────────────────────┘
 */

/** The model's state of a check, as the machine needs it (the observation stays out). */
export type StepVerdict = Pick<CoachVerdict, "status" | "confidence" | "redirect" | "target">;

export type CoachInput =
  /** The step was checked on a fresh screenshot: after "done", "I'm stuck", or resuming. */
  | { kind: "checked"; reason: "done" | "stuck" | "resume"; verdict: StepVerdict }
  /** Asked whether the step is done, the student said yes. */
  | { kind: "confirmed" }
  | { kind: "pause" }
  | { kind: "stop" };

export type Transition = { walkthrough: Walkthrough; reply: CoachReply };

/** Things said between steps, rotated so the praise doesn't repeat every time. */
const PRAISE = ["Nice.", "Good.", "That's it.", "Great.", "Well done."] as const;

export const COACH_SPEECH = {
  notSure: "I can't quite tell from here. Is it done?",
  confirmed: "Okay.",
  alreadyDone: "Looks like you've already done that one.",
  welcomeBack: "Welcome back.",
  pointing: "Look where I'm pointing",
  paused: "Okay, I'll wait. Press Resume when you're ready.",
  tooManyTries:
    "Let's leave this step for a moment. Have another go when you're ready, then press Resume.",
  stopped: 'Okay, we\'ll stop here. Say "continue where we left off" when you want to finish.',
  offTrack: "That's not quite where we're going.",
} as const;

/** A fresh walkthrough step, nothing tried yet. */
function untried(step: CoachPlan["steps"][number]): WalkthroughStep {
  return { ...step, hints: 0, checks: 0, misses: 0, outcome: null };
}

/** The steps of a plan, ready to store. */
export function stepsOf(plan: CoachPlan): WalkthroughStep[] {
  return plan.steps.slice(0, COACH_LIMITS.steps).map(untried);
}

/** The reply to a goal the planner couldn't plan from this screen (nothing is stored). */
export function declined(plan: Pick<CoachPlan, "title" | "intro">): CoachReply {
  return {
    walkthroughId: null,
    title: plan.title,
    status: "declined",
    phase: "awaiting",
    step: 0,
    total: 0,
    hintsUsed: 0,
    speech: speech(plan.intro),
    actions: [],
  };
}

/** The first reply of a stored walkthrough: the intro, step 1, and where to click. */
export function started(walkthrough: Walkthrough, intro: string, target: ScreenTarget | null) {
  const first = walkthrough.steps[0];
  return reply(walkthrough, `${intro} ${first?.instruction ?? ""}`, target, false);
}

/**
 * What happens next. An input that doesn't apply (a "yes" nobody asked for, anything once it's
 * completed, or anything but resuming once it's stopped) leaves it as it is and says where it
 * stands.
 */
export function advance(walkthrough: Walkthrough, input: CoachInput, now: string): Transition {
  const resuming = input.kind === "checked" && input.reason === "resume";
  if (walkthrough.status === "completed") return still(walkthrough);
  if (walkthrough.status === "stopped" && !resuming) return still(walkthrough);
  switch (input.kind) {
    case "pause":
      return settle(walkthrough, { status: "paused", phase: "awaiting" }, now, COACH_SPEECH.paused);
    case "stop":
      return settle(
        walkthrough,
        { status: "stopped", phase: "awaiting" },
        now,
        COACH_SPEECH.stopped,
      );
    case "confirmed":
      if (walkthrough.phase !== "confirming") return still(walkthrough);
      return finishStep(walkthrough, "confirmed", COACH_SPEECH.confirmed, null, now);
    case "checked":
      return afterCheck(walkthrough, input.reason, input.verdict, now);
  }
}

function afterCheck(
  walkthrough: Walkthrough,
  reason: "done" | "stuck" | "resume",
  verdict: StepVerdict,
  now: string,
): Transition {
  const sure = verdict.confidence >= COACH_LIMITS.confidence;
  const resumed: Walkthrough = { ...walkthrough, status: "active", phase: "awaiting" };
  const checked = updateStep(resumed, (step) => ({
    ...step,
    checks: step.checks + 1,
    // Resuming gives the step its tries back.
    misses: reason === "resume" ? 0 : step.misses,
  }));

  if (verdict.status === "completed" && sure) {
    const said =
      reason === "done"
        ? (PRAISE[walkthrough.current % PRAISE.length] ?? PRAISE[0])
        : reason === "stuck"
          ? COACH_SPEECH.alreadyDone
          : `${COACH_SPEECH.welcomeBack} ${COACH_SPEECH.alreadyDone}`;
    return finishStep(checked, "checked", said, verdict.target, now);
  }
  const step = currentStep(checked);
  if (reason === "resume") {
    // Back where they were: the step again, without counting a hint or a miss.
    const said = `${COACH_SPEECH.welcomeBack} Step ${checked.current + 1}: ${step.instruction}`;
    return { walkthrough: touch(checked, now), reply: reply(checked, said, verdict.target, false) };
  }
  if (reason === "done" && !sure) {
    const asking = touch({ ...checked, phase: "confirming" }, now);
    return { walkthrough: asking, reply: reply(asking, COACH_SPEECH.notSure, null, false) };
  }

  // Not done: a miss. The fourth one pauses the walkthrough (brief §5: 3 retries per step).
  const missed = updateStep(checked, (s) => ({ ...s, misses: s.misses + 1 }));
  if (currentStep(missed).misses > COACH_LIMITS.retries) {
    return settle(missed, { status: "paused", phase: "awaiting" }, now, COACH_SPEECH.tooManyTries);
  }
  if (reason === "done" && verdict.status === "off_track") {
    const said = verdict.redirect ?? `${COACH_SPEECH.offTrack} ${step.instruction}`;
    return { walkthrough: touch(missed, now), reply: reply(missed, said, verdict.target, false) };
  }
  return giveHint(missed, verdict.target, now);
}

/** Climbs the hint ladder one level (at most to the explicit instruction) and gives that hint. */
function giveHint(walkthrough: Walkthrough, target: ScreenTarget | null, now: string): Transition {
  const hinted = updateStep(walkthrough, (step) => ({
    ...step,
    hints: Math.min(step.hints + 1, COACH_LIMITS.hintLevels),
  }));
  const step = currentStep(hinted);
  const said =
    step.hints === 1
      ? step.hint
      : step.hints === 2 && target
        ? `${COACH_SPEECH.pointing}${target.label ? `: ${target.label}` : ""}.`
        : step.explicit;
  return { walkthrough: touch(hinted, now), reply: reply(hinted, said, target, step.hints >= 2) };
}

/** The current step is done: on to the next one, or the walkthrough is complete. */
function finishStep(
  walkthrough: Walkthrough,
  outcome: "checked" | "confirmed",
  said: string,
  nextTarget: ScreenTarget | null,
  now: string,
): Transition {
  const done = updateStep(walkthrough, (step) => ({ ...step, outcome }));
  const next = done.current + 1;
  const base = { ...done, status: "active" as const, phase: "awaiting" as const };
  if (next >= done.steps.length) {
    const completed = touch({ ...base, status: "completed", completedAt: now }, now);
    return { walkthrough: completed, reply: reply(completed, completion(completed), null, false) };
  }
  const moved = touch({ ...base, current: next }, now);
  const instruction = currentStep(moved).instruction;
  return { walkthrough: moved, reply: reply(moved, `${said} ${instruction}`, nextTarget, false) };
}

/** "You did it with 1 hint." */
export function completion(walkthrough: Walkthrough): string {
  const hints = hintsUsed(walkthrough);
  if (hints === 0) return "You did it, without a single hint!";
  return `You did it with ${hints} hint${hints === 1 ? "" : "s"}.`;
}

export function hintsUsed(walkthrough: Pick<Walkthrough, "steps">): number {
  return walkthrough.steps.reduce((sum, step) => sum + step.hints, 0);
}

/** A reply that leaves the walkthrough where it is (a check that failed, say), saying `said`. */
export function standing(walkthrough: Walkthrough, said: string): CoachReply {
  return reply(walkthrough, said, null, false);
}

/** Where a walkthrough stands, unchanged (an input that didn't apply). */
function still(walkthrough: Walkthrough): Transition {
  const said =
    walkthrough.status === "completed"
      ? completion(walkthrough)
      : walkthrough.phase === "confirming"
        ? COACH_SPEECH.notSure
        : currentStep(walkthrough).instruction;
  return { walkthrough, reply: reply(walkthrough, said, null, false) };
}

function settle(
  walkthrough: Walkthrough,
  change: Pick<Walkthrough, "status" | "phase">,
  now: string,
  said: string,
): Transition {
  const settled = touch({ ...walkthrough, ...change }, now);
  return { walkthrough: settled, reply: reply(settled, said, null, false) };
}

function reply(
  walkthrough: Walkthrough,
  said: string,
  target: ScreenTarget | null,
  withLabel: boolean,
): CoachReply {
  const playing = walkthrough.status === "active";
  return {
    walkthroughId: walkthrough.id,
    title: walkthrough.title,
    status: walkthrough.status,
    phase: walkthrough.phase,
    step: walkthrough.current + 1,
    total: walkthrough.steps.length,
    hintsUsed: hintsUsed(walkthrough),
    speech: speech(said),
    actions: playing && target ? pointAt(target, withLabel) : [],
  };
}

/**
 * An arrow to the control, with its name from hint 2 on. The focus region around it anchors
 * the ink (and keeps the arrow's label off the control itself).
 */
export function pointAt(target: ScreenTarget, withLabel: boolean): TutorScreenAction[] {
  const { x, y } = target.point;
  const r = 30;
  const box = {
    left: Math.max(0, x - r),
    top: Math.max(0, y - r),
    right: Math.min(1000, x + r),
    bottom: Math.min(1000, y + r),
  };
  return [
    { type: "focus_region", box, kind: "text" },
    {
      type: "point_at",
      point: target.point,
      ...(withLabel && target.label ? { label: target.label } : {}),
    },
  ];
}

/** Spoken text: one line, within the screen's speech cap (cut at a word if it must be). */
function speech(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SCREEN_LIMITS.speechChars) return flat;
  const cut = flat.slice(0, SCREEN_LIMITS.speechChars - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 1))}…`;
}

function currentStep(walkthrough: Walkthrough): WalkthroughStep {
  const step = walkthrough.steps[walkthrough.current];
  // The schema guarantees it; this keeps the types honest.
  if (!step) throw new Error("walkthrough has no current step");
  return step;
}

function updateStep(
  walkthrough: Walkthrough,
  change: (step: WalkthroughStep) => WalkthroughStep,
): Walkthrough {
  return {
    ...walkthrough,
    steps: walkthrough.steps.map((step, i) => (i === walkthrough.current ? change(step) : step)),
  };
}

function touch(walkthrough: Walkthrough, now: string): Walkthrough {
  return { ...walkthrough, updatedAt: now };
}
