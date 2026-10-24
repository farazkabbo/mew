import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CoachPlan,
  CoachReply,
  CoachStepRequest,
  CoachVerdict,
  Walkthrough,
  WalkthroughCreate,
} from "./coach";
import { stepsOf } from "./coach-machine";
import { renderPlannerInput, renderVerifierInput } from "./prompts/coach";
import { renderScreenInput } from "./prompts/screen";
import { coachPlanReasons, coachVerdictReasons } from "./screen-safety";

const ID = "11111111-1111-4111-8111-111111111111";
const IMAGE = { jpeg: "/9j/4AAQ", width: 1600, height: 900 };

const STEP = {
  instruction: "Click Insert, at the top.",
  successCondition: "The Insert tab is selected.",
  hint: "Pivot tables are made from the Insert tab.",
  explicit: "Click the Insert tab at the top left.",
};

const PLAN = {
  feasible: true,
  title: "Pivot tables",
  intro: "Let's make a pivot table together.",
  steps: [STEP, { ...STEP, instruction: "Click PivotTable." }],
  firstTarget: { point: { x: 120, y: 40 }, label: "Insert" },
};

const STORED = {
  id: ID,
  title: "Pivot tables",
  goal: "teach me how to make a pivot table",
  app: "excel.exe",
  status: "active",
  phase: "awaiting",
  current: 1,
  steps: stepsOf(CoachPlan.parse(PLAN)),
  revision: 3,
  startedAt: "2026-10-23T10:00:00+00:00",
  updatedAt: "2026-10-23T10:05:00.123456+00:00",
  completedAt: null,
};

describe("coach schemas", () => {
  it("accepts a plan and a verdict as the models return them", () => {
    expect(CoachPlan.parse(PLAN).steps).toHaveLength(2);
    expect(
      CoachVerdict.parse({
        observation: "The Insert tab is open.",
        status: "completed",
        confidence: 0.92,
        redirect: null,
        target: { point: { x: 300, y: 60 }, label: "PivotTable" },
      }).status,
    ).toBe("completed");
  });

  it("refuses model text that's empty, over-long or has control characters", () => {
    for (const bad of [
      { ...PLAN, title: "   " },
      { ...PLAN, steps: [{ ...STEP, instruction: "x".repeat(161) }] },
      { ...PLAN, steps: [{ ...STEP, hint: "line\u0007" }] },
      { ...PLAN, firstTarget: { point: { x: 1001, y: 0 } } },
      { ...PLAN, steps: Array.from({ length: 16 }, () => STEP) },
    ]) {
      expect(CoachPlan.safeParse(bad).success).toBe(false);
    }
  });

  it("can be described to Gemini (no tuples, no transforms)", () => {
    for (const schema of [CoachPlan, CoachVerdict]) {
      const json = JSON.stringify(z.toJSONSchema(schema));
      expect(json).not.toContain("prefixItems");
    }
  });

  it("reads a stored walkthrough, and refuses one whose current step doesn't exist", () => {
    expect(Walkthrough.parse(STORED).current).toBe(1);
    expect(Walkthrough.safeParse({ ...STORED, current: 2 }).success).toBe(false);
    expect(Walkthrough.safeParse({ ...STORED, steps: [] }).success).toBe(false);
    expect(Walkthrough.safeParse({ ...STORED, app: "C:\\evil.exe" }).success).toBe(false);
    expect(
      WalkthroughCreate.safeParse({ title: "x", goal: "y".repeat(201), app: null, steps: [] })
        .success,
    ).toBe(false);
  });

  it("needs a screenshot to check a step, and none for yes, pause or stop", () => {
    const scene = { app: "excel.exe", scope: "monitor", image: IMAGE } as const;
    expect(CoachStepRequest.safeParse({ walkthroughId: ID, event: "done", ...scene }).success).toBe(
      true,
    );
    expect(CoachStepRequest.safeParse({ walkthroughId: ID, event: "done" }).success).toBe(false);
    expect(CoachStepRequest.safeParse({ walkthroughId: ID, event: "stuck" }).success).toBe(false);
    for (const event of ["yes", "pause", "stop"]) {
      expect(CoachStepRequest.safeParse({ walkthroughId: ID, event }).success).toBe(true);
    }
    expect(CoachStepRequest.safeParse({ walkthroughId: ID, event: "skip" }).success).toBe(false);
    expect(CoachStepRequest.safeParse({ walkthroughId: "x", event: "stop" }).success).toBe(false);
  });

  it("lets a reply carry at most a focus region and an arrow", () => {
    const reply = {
      walkthroughId: ID,
      title: "Pivot tables",
      status: "active",
      phase: "awaiting",
      step: 1,
      total: 2,
      hintsUsed: 0,
      speech: "Click Insert.",
      actions: [],
    };
    expect(CoachReply.safeParse(reply).success).toBe(true);
    const three = Array.from({ length: 3 }, () => ({ type: "clear" }));
    expect(CoachReply.safeParse({ ...reply, actions: three }).success).toBe(false);
  });
});

describe("coach safety", () => {
  it("passes an ordinary plan", () => {
    expect(coachPlanReasons(CoachPlan.parse(PLAN))).toEqual([]);
  });

  it("refuses a plan if any text, even a success condition, breaks a rule", () => {
    const plan = (step: Partial<typeof STEP>) =>
      CoachPlan.parse({ ...PLAN, steps: [{ ...STEP, ...step }] });
    expect(coachPlanReasons(plan({ explicit: "Open PowerShell and paste the line." }))).toEqual([
      "run_commands",
    ]);
    expect(coachPlanReasons(plan({ successCondition: "A PowerShell window is open." }))).toEqual([
      "run_commands",
    ]);
    expect(coachPlanReasons(plan({ hint: "Turn off Windows Defender first." }))).toEqual([
      "disable_security",
    ]);
    expect(coachPlanReasons(plan({ instruction: "Type your password in the box." }))).toEqual([
      "asks_for_secrets",
    ]);
  });

  it("checks a verdict's redirect and the control's name", () => {
    expect(
      coachVerdictReasons({
        redirect: "Close that and open Command Prompt instead.",
        target: null,
      }),
    ).toEqual(["run_commands"]);
    expect(
      coachVerdictReasons({ redirect: null, target: { point: { x: 1, y: 1 }, label: "Insert" } }),
    ).toEqual([]);
  });
});

/** A prompt input as an object (they are JSON). */
const parsed = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe("coach prompts", () => {
  it("gives the planner the goal and the screenshot's size, nothing else", () => {
    const input: unknown = JSON.parse(
      renderPlannerInput({ goal: "make a pivot table", app: null, scope: "window", image: IMAGE }),
    );
    expect(input).toEqual({
      goal: "make a pivot table",
      app: "unknown",
      screenshot: "attached: the window they're working in, 1600×900 pixels",
    });
  });

  it("gives the verifier the step, its success condition and the next step", () => {
    const walkthrough = Walkthrough.parse({ ...STORED, current: 0 });
    const input: unknown = JSON.parse(
      renderVerifierInput(walkthrough, {
        app: "excel.exe",
        scope: "monitor",
        width: 10,
        height: 5,
      }),
    );
    expect(input).toEqual({
      walkthrough: "Pivot tables",
      step: {
        number: 1,
        instruction: STEP.instruction,
        successCondition: STEP.successCondition,
      },
      nextStep: { instruction: "Click PivotTable." },
      app: "excel.exe",
      screenshot: "attached: the whole monitor, 10×5 pixels",
    });
    const last = parsed(
      renderVerifierInput(Walkthrough.parse(STORED), {
        app: null,
        scope: "monitor",
        width: 10,
        height: 5,
      }),
    );
    expect(last.nextStep).toBeNull();
  });

  it("tells the screen tutor which walkthrough a question was asked in", () => {
    const ask = {
      transcript: "what's a pivot table?",
      app: "excel.exe",
      scope: "monitor",
      image: IMAGE,
    } as const;
    expect(parsed(renderScreenInput(ask)).walkthrough).toBeUndefined();
    const context = { title: "Pivot tables", step: 2, instruction: "Click PivotTable." };
    expect(parsed(renderScreenInput(ask, context)).walkthrough).toEqual(context);
  });
});
