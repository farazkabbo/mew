import { z } from "zod";

import { AppName, ScreenImage, ScreenPoint, SCREEN_LIMITS, TutorScreenAction } from "./screen";

/**
 * Coach mode (Screen Coach S4, docs/SCREEN_COACH.md §2.2, §5 and decision 10): a guided
 * walkthrough of a task on the student's screen, one step at a time, checked on the screen
 * after each one.
 *
 * Who does what:
 * - the planner model plans the steps once (`CoachPlan`), the verifier model checks each one
 *   (`CoachVerdict`);
 * - the state machine (`coach-machine.ts`, pure) decides what happens next and what is said;
 * - the API service stores the walkthrough (`Walkthrough`: text only, never a screenshot);
 * - the desktop app shows it (`CoachReply`: speech, an arrow, the progress pill).
 */
export const COACH_LIMITS = {
  /** The brief's caps (§5): steps per walkthrough, and retries per step before pausing. */
  steps: 15,
  retries: 3,
  /** Hint levels: 1 a nudge, 2 an arrow with the control's name, 3 the explicit instruction. */
  hintLevels: 3,
  /** A verdict below this confidence isn't acted on: the student is asked instead (§5). */
  confidence: 0.75,
  /** "Continue where we left off" finds walkthroughs touched within this many days. */
  resumeDays: 7,
  titleChars: 60,
  goalChars: 200,
  introChars: 160,
  instructionChars: 160,
  conditionChars: 160,
  hintChars: 160,
  explicitChars: 220,
  redirectChars: 160,
  observationChars: 400,
} as const;

const Text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\u0000-\u001f\u007f]/.test(text), {
      message: "control characters aren't allowed",
    });

/** Where to point on a screenshot (0–1000), with the control's name (1–3 words). */
export const ScreenTarget = z.object({
  point: ScreenPoint,
  label: Text(SCREEN_LIMITS.labelChars).optional(),
});
export type ScreenTarget = z.infer<typeof ScreenTarget>;

/** One step as planned: what to say, how to tell it's done, and two hints. */
export const PlannedStep = z.object({
  /** One short spoken sentence: what to do ("Click Insert, at the top."). */
  instruction: Text(COACH_LIMITS.instructionChars),
  /** What the screen shows once it's done, checkable on a screenshot. Never shown or said. */
  successCondition: Text(COACH_LIMITS.conditionChars),
  /** Hint 1: a nudge that doesn't give it away. */
  hint: Text(COACH_LIMITS.hintChars),
  /** Hint 3: the exact instruction. */
  explicit: Text(COACH_LIMITS.explicitChars),
});
export type PlannedStep = z.infer<typeof PlannedStep>;

/** What the planner model returns (prompt `coach-planner`). */
export const CoachPlan = z.object({
  /** False when the goal can't be done from this screen (the intro says what's needed first). */
  feasible: z.boolean(),
  /** 1–4 words naming the skill ("Pivot tables"). */
  title: Text(COACH_LIMITS.titleChars),
  /** One sentence to begin with (or, when not feasible, what to do first). */
  intro: Text(COACH_LIMITS.introChars),
  steps: z.array(PlannedStep).max(COACH_LIMITS.steps),
  /** Where step 1's control is on this screenshot, if it's visible. */
  firstTarget: ScreenTarget.nullable(),
});
export type CoachPlan = z.infer<typeof CoachPlan>;

export const VerdictStatus = z.enum(["completed", "not_completed", "off_track"]);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

/** What the verifier model returns for one step (prompt `coach-verifier`). */
export const CoachVerdict = z.object({
  /** What it sees that matters for the step (reasoning first; never stored, shown or logged). */
  observation: z.string().max(COACH_LIMITS.observationChars),
  status: VerdictStatus,
  confidence: z.number().min(0).max(1),
  /** For "off_track": one short spoken sentence bringing the student back. */
  redirect: Text(COACH_LIMITS.redirectChars).nullable(),
  /** Where to act now: the next step's control if this one is done, otherwise this one's. */
  target: ScreenTarget.nullable(),
});
export type CoachVerdict = z.infer<typeof CoachVerdict>;

// ─── The stored walkthrough ──────────────────────────────────────────────────────────────────

/** How a step was finished: seen on the screen, or the student said so when asked. */
export const StepOutcome = z.enum(["checked", "confirmed"]);
export type StepOutcome = z.infer<typeof StepOutcome>;

/** A planned step and how it went (what S5 turns into evidence). */
export const WalkthroughStep = PlannedStep.extend({
  /** The highest hint level the student was given (0–3). */
  hints: z.number().int().min(0).max(COACH_LIMITS.hintLevels),
  /** Every check of this step (each a verifier call). */
  checks: z.number().int().min(0).max(1000),
  /** Checks that didn't finish it since it was last started or resumed (the retry cap). */
  misses: z
    .number()
    .int()
    .min(0)
    .max(COACH_LIMITS.retries + 1),
  outcome: StepOutcome.nullable(),
});
export type WalkthroughStep = z.infer<typeof WalkthroughStep>;

export const WalkthroughStatus = z.enum(["active", "paused", "stopped", "completed"]);
export type WalkthroughStatus = z.infer<typeof WalkthroughStatus>;

/** "awaiting": waiting for the student to do the step; "confirming": asked whether it's done. */
export const WalkthroughPhase = z.enum(["awaiting", "confirming"]);
export type WalkthroughPhase = z.infer<typeof WalkthroughPhase>;

const Steps = z.array(WalkthroughStep).min(1).max(COACH_LIMITS.steps);

/** What changes as a walkthrough goes on (`current` is the step being done, from 0). */
const Progress = z.object({
  status: WalkthroughStatus,
  phase: WalkthroughPhase,
  current: z
    .number()
    .int()
    .min(0)
    .max(COACH_LIMITS.steps - 1),
  steps: Steps,
});

const currentIsAStep = (w: { current: number; steps: unknown[] }) => w.current < w.steps.length;

/** A walkthrough as the API service stores it. */
export const Walkthrough = Progress.extend({
  id: z.uuid(),
  title: Text(COACH_LIMITS.titleChars),
  /** What the student asked, in their words. */
  goal: Text(COACH_LIMITS.goalChars),
  app: AppName.nullable(),
  /** Bumped by every update: an update names the revision it read (two "done"s can't race). */
  revision: z.number().int().min(0),
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
}).refine(currentIsAStep, "the current step must be one of the steps");
export type Walkthrough = z.infer<typeof Walkthrough>;

/** `POST /v1/walkthroughs/device`: a new walkthrough (active, at step 1). */
export const WalkthroughCreate = z.object({
  title: Text(COACH_LIMITS.titleChars),
  goal: Text(COACH_LIMITS.goalChars),
  app: AppName.nullable(),
  steps: Steps,
});
export type WalkthroughCreate = z.infer<typeof WalkthroughCreate>;

/** `PUT /v1/walkthroughs/device/{id}`: the walkthrough's progress, if it's still at `revision`. */
export const WalkthroughUpdate = Progress.extend({
  revision: z.number().int().min(0),
}).refine(currentIsAStep, "the current step must be one of the steps");
export type WalkthroughUpdate = z.infer<typeof WalkthroughUpdate>;

// ─── The desktop app ─────────────────────────────────────────────────────────────────────────

const Scope = z.enum(["window", "monitor"]);

/** `POST /api/screen/coach/start`: "teach me how to…" over the hotkey, with the screen. */
export const CoachStartRequest = z.object({
  /** The student's words: the goal. */
  goal: z.string().trim().min(1).max(SCREEN_LIMITS.transcriptChars),
  app: AppName.nullable(),
  scope: Scope,
  image: ScreenImage,
});
export type CoachStartRequest = z.infer<typeof CoachStartRequest>;

/** `POST /api/screen/coach/resume`: "continue where we left off", with the screen. */
export const CoachResumeRequest = z.object({
  app: AppName.nullable(),
  scope: Scope,
  image: ScreenImage,
});
export type CoachResumeRequest = z.infer<typeof CoachResumeRequest>;

/**
 * `POST /api/screen/coach/step`: something happened in a walkthrough.
 * - done: the student says the step is done (check it on the screen);
 * - stuck: they want help (checked first: it may be done);
 * - yes: asked whether it's done, they said it is;
 * - pause, stop: from the pill, by voice or the tray.
 */
export const CoachStepRequest = z.discriminatedUnion("event", [
  z.object({
    walkthroughId: z.uuid(),
    event: z.enum(["done", "stuck"]),
    app: AppName.nullable(),
    scope: Scope,
    image: ScreenImage,
  }),
  z.object({ walkthroughId: z.uuid(), event: z.enum(["yes", "pause", "stop"]) }),
]);
export type CoachStepRequest = z.infer<typeof CoachStepRequest>;

/** What the desktop app shows: the pill's state, what to say, and the arrow (if any). */
export const CoachReply = z.object({
  /** Null when no walkthrough was started (the goal can't be done from this screen). */
  walkthroughId: z.uuid().nullable(),
  title: z.string().max(COACH_LIMITS.titleChars),
  status: z.enum(["declined", ...WalkthroughStatus.options]),
  phase: WalkthroughPhase,
  /** The step being done, from 1 (0 when declined). */
  step: z.number().int().min(0).max(COACH_LIMITS.steps),
  total: z.number().int().min(0).max(COACH_LIMITS.steps),
  hintsUsed: z
    .number()
    .int()
    .min(0)
    .max(COACH_LIMITS.steps * COACH_LIMITS.hintLevels),
  speech: z.string().min(1).max(SCREEN_LIMITS.speechChars),
  /** A focus region and an arrow to the control, or nothing. */
  actions: z.array(TutorScreenAction).max(2),
});
export type CoachReply = z.infer<typeof CoachReply>;
