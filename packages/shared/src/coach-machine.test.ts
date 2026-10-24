import { describe, expect, it } from "vitest";

import { type CoachPlan, Walkthrough } from "./coach";
import {
  advance,
  COACH_SPEECH,
  type CoachInput,
  completion,
  declined,
  started,
  stepsOf,
  type StepVerdict,
} from "./coach-machine";

const NOW = "2026-10-23T10:00:00.000Z";
const LATER = "2026-10-23T10:01:00.000Z";

const PLAN: CoachPlan = {
  feasible: true,
  title: "Pivot tables",
  intro: "Let's make a pivot table together.",
  steps: [
    {
      instruction: "Click Insert, at the top.",
      successCondition: "The Insert tab is selected.",
      hint: "Pivot tables are made from the Insert tab.",
      explicit: "Click the Insert tab at the top left.",
    },
    {
      instruction: "Click PivotTable.",
      successCondition: "The Create PivotTable dialog is open.",
      hint: "It's the first button on the left.",
      explicit: "Click PivotTable, the first button of the Insert tab.",
    },
    {
      instruction: "Click OK.",
      successCondition: "A new sheet shows the PivotTable Fields pane.",
      hint: "The dialog is ready as it is.",
      explicit: "Click the OK button at the bottom of the dialog.",
    },
  ],
  firstTarget: { point: { x: 120, y: 40 }, label: "Insert" },
};

function walkthrough(): Walkthrough {
  return Walkthrough.parse({
    id: "11111111-1111-4111-8111-111111111111",
    title: PLAN.title,
    goal: "teach me how to make a pivot table",
    app: "excel.exe",
    status: "active",
    phase: "awaiting",
    current: 0,
    steps: stepsOf(PLAN),
    revision: 0,
    startedAt: NOW,
    updatedAt: NOW,
    completedAt: null,
  });
}

const TARGET = { point: { x: 300, y: 60 }, label: "PivotTable" };

const verdict = (change: Partial<StepVerdict> = {}): StepVerdict => ({
  status: "completed",
  confidence: 0.9,
  redirect: null,
  target: TARGET,
  ...change,
});

const done = (change: Partial<StepVerdict> = {}): CoachInput => ({
  kind: "checked",
  reason: "done",
  verdict: verdict(change),
});

const notDone = (change: Partial<StepVerdict> = {}) => done({ status: "not_completed", ...change });

/** Runs inputs one after another, like requests do. */
function run(start: Walkthrough, ...inputs: CoachInput[]) {
  let current = start;
  const replies = [];
  for (const input of inputs) {
    const next = advance(current, input, LATER);
    current = next.walkthrough;
    replies.push(next.reply);
  }
  return { walkthrough: current, replies, last: replies.at(-1) };
}

describe("starting", () => {
  it("says the intro and the first step, and points at its control", () => {
    const reply = started(walkthrough(), PLAN.intro, PLAN.firstTarget);
    expect(reply).toMatchObject({
      status: "active",
      step: 1,
      total: 3,
      hintsUsed: 0,
      speech: "Let's make a pivot table together. Click Insert, at the top.",
    });
    expect(reply.actions).toEqual([
      { type: "focus_region", box: { left: 90, top: 10, right: 150, bottom: 70 }, kind: "text" },
      { type: "point_at", point: { x: 120, y: 40 } },
    ]);
  });

  it("declines without a walkthrough when the goal can't be done here", () => {
    expect(declined({ title: "Pivot tables", intro: "Open Excel first." })).toMatchObject({
      walkthroughId: null,
      status: "declined",
      step: 0,
      speech: "Open Excel first.",
      actions: [],
    });
  });

  it("keeps at most 15 steps, each untried", () => {
    const many = { ...PLAN, steps: Array.from({ length: 20 }, () => PLAN.steps).flat() };
    const steps = stepsOf(many);
    expect(steps).toHaveLength(15); // of 60
    expect(steps[0]).toMatchObject({ hints: 0, checks: 0, misses: 0, outcome: null });
  });
});

describe("checking a step", () => {
  it("moves on with praise and the next step when it's clearly done", () => {
    const { walkthrough: w, last } = run(walkthrough(), done());
    expect(w.current).toBe(1);
    expect(w.steps[0]).toMatchObject({ outcome: "checked", checks: 1, hints: 0 });
    expect(w.updatedAt).toBe(LATER);
    expect(last).toMatchObject({ step: 2, speech: "Nice. Click PivotTable." });
    // The arrow points at the next step's control, without a label (it isn't a hint).
    expect(last?.actions[1]).toEqual({ type: "point_at", point: TARGET.point });
  });

  it("asks the student when the verifier isn't sure, whatever it thinks", () => {
    for (const status of ["completed", "not_completed", "off_track"] as const) {
      const { walkthrough: w, last } = run(walkthrough(), done({ status, confidence: 0.6 }));
      expect(w).toMatchObject({ current: 0, phase: "confirming" });
      expect(w.steps[0]).toMatchObject({ hints: 0, misses: 0 });
      expect(last).toMatchObject({ phase: "confirming", speech: COACH_SPEECH.notSure });
    }
  });

  it("takes the student's word when asked, without an arrow it hasn't checked", () => {
    const { walkthrough: w, last } = run(walkthrough(), done({ confidence: 0.5 }), {
      kind: "confirmed",
    });
    expect(w).toMatchObject({ current: 1, phase: "awaiting" });
    expect(w.steps[0]?.outcome).toBe("confirmed");
    expect(last).toMatchObject({ speech: "Okay. Click PivotTable.", actions: [] });
  });

  it("ignores a yes nobody asked for", () => {
    const { walkthrough: w } = run(walkthrough(), { kind: "confirmed" });
    expect(w).toEqual(walkthrough());
  });

  it("detects a skipped step and climbs the hint ladder: nudge, arrow with its name, exact words", () => {
    const { walkthrough: w, replies } = run(walkthrough(), notDone(), notDone(), notDone());
    expect(replies.map((r) => r.speech)).toEqual([
      "Pivot tables are made from the Insert tab.",
      "Look where I'm pointing: PivotTable.",
      "Click the Insert tab at the top left.",
    ]);
    expect(replies[0]?.actions[1]).toEqual({ type: "point_at", point: TARGET.point });
    expect(replies[1]?.actions[1]).toEqual({
      type: "point_at",
      point: TARGET.point,
      label: "PivotTable",
    });
    expect(w.steps[0]).toMatchObject({ hints: 3, misses: 3, checks: 3, outcome: null });
    expect(replies[2]?.hintsUsed).toBe(3);
  });

  it("gives the exact words when it can't point at the control", () => {
    const { replies } = run(walkthrough(), notDone({ target: null }), notDone({ target: null }));
    expect(replies[1]).toMatchObject({
      speech: "Click the Insert tab at the top left.",
      actions: [],
    });
  });

  it("brings an off-track student back without counting a hint", () => {
    const { walkthrough: w, last } = run(
      walkthrough(),
      done({ status: "off_track", redirect: "That's Page Layout; we want Insert." }),
    );
    expect(w.steps[0]).toMatchObject({ hints: 0, misses: 1 });
    expect(last).toMatchObject({ speech: "That's Page Layout; we want Insert." });
    expect(last?.actions).toHaveLength(2);
    const plain = run(walkthrough(), done({ status: "off_track", redirect: null })).last;
    expect(plain?.speech).toBe(`${COACH_SPEECH.offTrack} Click Insert, at the top.`);
  });

  it("pauses after the fourth miss on a step (3 retries), and resuming gives the tries back", () => {
    const tried = run(walkthrough(), notDone(), notDone(), notDone(), notDone());
    expect(tried.walkthrough).toMatchObject({ status: "paused", current: 0 });
    expect(tried.last).toMatchObject({ status: "paused", speech: COACH_SPEECH.tooManyTries });
    expect(tried.last?.actions).toEqual([]);

    const back = run(tried.walkthrough, {
      kind: "checked",
      reason: "resume",
      verdict: verdict({ status: "not_completed" }),
    });
    expect(back.walkthrough).toMatchObject({ status: "active", current: 0 });
    expect(back.walkthrough.steps[0]).toMatchObject({ misses: 0, hints: 3 });
    expect(back.last?.speech).toBe(`${COACH_SPEECH.welcomeBack} Step 1: Click Insert, at the top.`);
  });

  it("checks first when the student is stuck: it may already be done", () => {
    const stuck = (v: Partial<StepVerdict>): CoachInput => ({
      kind: "checked",
      reason: "stuck",
      verdict: verdict(v),
    });
    const already = run(walkthrough(), stuck({}));
    expect(already.walkthrough.current).toBe(1);
    expect(already.last?.speech).toBe(`${COACH_SPEECH.alreadyDone} Click PivotTable.`);

    // Not sure, or off track: they asked for help, so they get a hint (never a question back).
    for (const v of [{ confidence: 0.4 }, { status: "off_track" as const }]) {
      const hinted = run(walkthrough(), stuck(v));
      expect(hinted.walkthrough.steps[0]?.hints).toBe(1);
      expect(hinted.last?.speech).toBe("Pivot tables are made from the Insert tab.");
    }
  });

  it("answers being stuck while asked whether it's done with a hint", () => {
    const { walkthrough: w, last } = run(walkthrough(), done({ confidence: 0.5 }), {
      kind: "checked",
      reason: "stuck",
      verdict: verdict({ status: "not_completed" }),
    });
    expect(w).toMatchObject({ phase: "awaiting" });
    expect(last?.speech).toBe("Pivot tables are made from the Insert tab.");
  });
});

describe("finishing", () => {
  it("completes after the last step and says how many hints it took", () => {
    const { walkthrough: w, last } = run(walkthrough(), done(), notDone(), done(), done());
    expect(w).toMatchObject({ status: "completed", completedAt: LATER, current: 2 });
    expect(w.steps.map((s) => s.outcome)).toEqual(["checked", "checked", "checked"]);
    expect(last).toMatchObject({
      status: "completed",
      speech: "You did it with 1 hint.",
      hintsUsed: 1,
      actions: [],
    });
    expect(completion(walkthrough())).toBe("You did it, without a single hint!");
  });

  it("ignores anything once it's over", () => {
    const over = run(walkthrough(), done(), done(), done()).walkthrough;
    for (const input of [notDone(), { kind: "pause" } as const, { kind: "stop" } as const]) {
      expect(run(over, input).walkthrough).toEqual(over);
    }
  });
});

describe("pausing and stopping", () => {
  it("pauses and stops without forgetting where the student was", () => {
    const paused = run(walkthrough(), done(), { kind: "pause" });
    expect(paused.walkthrough).toMatchObject({ status: "paused", current: 1 });
    expect(paused.last).toMatchObject({ status: "paused", speech: COACH_SPEECH.paused });

    const stopped = run(paused.walkthrough, { kind: "stop" });
    expect(stopped.walkthrough).toMatchObject({ status: "stopped", current: 1 });
    expect(stopped.last?.speech).toBe(COACH_SPEECH.stopped);
  });

  it("resumes a stopped walkthrough on the step it was on, and nothing else wakes it", () => {
    const stopped = run(walkthrough(), done(), { kind: "stop" }).walkthrough;
    expect(run(stopped, done()).walkthrough).toEqual(stopped);

    const back = advance(stopped, { kind: "checked", reason: "resume", verdict: verdict() }, LATER);
    expect(back.walkthrough).toMatchObject({ status: "active", current: 2 });
    expect(back.reply.speech).toBe(
      `${COACH_SPEECH.welcomeBack} ${COACH_SPEECH.alreadyDone} Click OK.`,
    );
  });
});

describe("what it says", () => {
  it("keeps every reply within the speech cap", () => {
    const long = "word ".repeat(80).trim();
    const reply = started(walkthrough(), long, null);
    expect(reply.speech.length).toBeLessThanOrEqual(300);
    expect(reply.speech.endsWith("…")).toBe(true);
  });
});
