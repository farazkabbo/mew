import {
  type CoachPlan,
  type CoachVerdict,
  Walkthrough,
  type WalkthroughCreate,
  type WalkthroughUpdate,
} from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { type GenerateStructured, ModelBusyError, type StructuredRequest } from "../gemini";
import {
  COACH_MESSAGES,
  type CoachDeps,
  resumeCoaching,
  startCoaching,
  stepCoaching,
  walkthroughContext,
} from "./run";
import type { WalkthroughStore } from "./store";

vi.stubEnv("GEMINI_API_KEY", "test-key");

const IMAGE = { jpeg: "/9j/4AAQ", width: 1600, height: 900 };
const SCENE = { app: "excel.exe", scope: "monitor", image: IMAGE } as const;
const NOW = new Date("2026-10-23T10:00:00.000Z");

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
  ],
  firstTarget: { point: { x: 120, y: 40 }, label: "Insert" },
};

const VERDICT: CoachVerdict = {
  observation: "The Insert tab is selected.",
  status: "completed",
  confidence: 0.95,
  redirect: null,
  target: { point: { x: 300, y: 70 }, label: "PivotTable" },
};

/** A walkthrough store in memory, with the API's compare-and-set on `revision`. */
function memoryStore() {
  const rows = new Map<string, Walkthrough>();
  const writes: WalkthroughUpdate[] = [];
  const store: WalkthroughStore = {
    create: (body: WalkthroughCreate) => {
      const row = Walkthrough.parse({
        ...body,
        id: "11111111-1111-4111-8111-111111111111",
        status: "active",
        phase: "awaiting",
        current: 0,
        revision: 0,
        startedAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        completedAt: null,
      });
      rows.set(row.id, row);
      return Promise.resolve(row);
    },
    get: (id) => Promise.resolve(rows.get(id) ?? null),
    latest: () => Promise.resolve([...rows.values()].find((r) => r.status !== "completed") ?? null),
    update: (id, update) => {
      const row = rows.get(id);
      if (!row || row.revision !== update.revision) return Promise.resolve(null);
      writes.push(update);
      const next = { ...row, ...update, revision: update.revision + 1 };
      rows.set(id, next);
      return Promise.resolve(next);
    },
  };
  return { store, rows, writes };
}

/** Deps whose model answers each call with the next of `answers` (by schema, in order). */
function deps(store: WalkthroughStore, ...answers: unknown[]) {
  const requests: StructuredRequest<unknown>[] = [];
  const answer: GenerateStructured = <T>(request: StructuredRequest<T>) => {
    requests.push(request as StructuredRequest<unknown>);
    const next = answers.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(request.schema.parse(next));
  };
  const generate = vi.fn(answer);
  const coach: CoachDeps = { generate: generate as GenerateStructured, store, now: () => NOW };
  return { coach, requests, generate };
}

async function startedOne() {
  const memory = memoryStore();
  const { coach } = deps(memory.store, PLAN);
  const reply = await startCoaching(
    { goal: "teach me how to make a pivot table", ...SCENE },
    coach,
  );
  return { ...memory, reply };
}

describe("starting a walkthrough", () => {
  it("plans it with the screen model, stores it, and shows step 1 with an arrow", async () => {
    const memory = memoryStore();
    const { coach, requests } = deps(memory.store, PLAN);
    const reply = await startCoaching({ goal: "  teach me   pivot tables ", ...SCENE }, coach);

    expect(reply).toMatchObject({
      walkthroughId: "11111111-1111-4111-8111-111111111111",
      title: "Pivot tables",
      status: "active",
      step: 1,
      total: 2,
      speech: "Let's make a pivot table together. Click Insert, at the top.",
    });
    expect(reply.actions.map((a) => a.type)).toEqual(["focus_region", "point_at"]);
    const stored = [...memory.rows.values()][0];
    expect(stored).toMatchObject({ goal: "teach me pivot tables", app: "excel.exe" });
    expect(stored?.steps[0]).toMatchObject({ hints: 0, checks: 0, outcome: null });

    const request = requests[0];
    expect(request?.system).toContain("You plan a guided walkthrough");
    expect(request?.input).toEqual([
      expect.objectContaining({ type: "text" }),
      { type: "image", base64: IMAGE.jpeg, mimeType: "image/jpeg" },
    ]);
  });

  it("declines without storing anything when the goal can't be done here", async () => {
    const memory = memoryStore();
    const { coach } = deps(memory.store, {
      ...PLAN,
      feasible: false,
      intro: "Open Excel with your data, then ask me again.",
      steps: [],
      firstTarget: null,
    });
    const reply = await startCoaching({ goal: "make a pivot table", ...SCENE }, coach);
    expect(reply).toMatchObject({
      walkthroughId: null,
      status: "declined",
      speech: "Open Excel with your data, then ask me again.",
    });
    expect(memory.rows.size).toBe(0);
  });

  it("refuses a plan that any of its texts would make unsafe", async () => {
    const memory = memoryStore();
    const unsafe = {
      ...PLAN,
      steps: [{ ...PLAN.steps[0], explicit: "Open PowerShell and paste this line." }],
    };
    const { coach } = deps(memory.store, unsafe);
    const reply = await startCoaching({ goal: "fix my PC", ...SCENE }, coach);
    expect(reply).toMatchObject({ status: "declined", speech: COACH_MESSAGES.refused });
    expect(memory.rows.size).toBe(0);
  });
});

describe("a step", () => {
  it("checks it with the verifier model and moves on", async () => {
    const { store, writes } = await startedOne();
    const { coach, requests } = deps(store, VERDICT);
    const reply = await stepCoaching(
      { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "done", ...SCENE },
      coach,
    );
    expect(reply).toMatchObject({ step: 2, speech: "Nice. Click PivotTable." });
    expect(writes).toEqual([expect.objectContaining({ revision: 0, current: 1 })]);
    expect(requests[0]?.system).toContain("You check one step");
    expect(requests[0]?.input[0]).toMatchObject({
      text: expect.stringContaining("The Insert tab is selected.") as unknown,
    });
  });

  it("gives a hint when the step isn't done", async () => {
    const { store } = await startedOne();
    const { coach } = deps(store, { ...VERDICT, status: "not_completed" });
    const reply = await stepCoaching(
      { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "done", ...SCENE },
      coach,
    );
    expect(reply).toMatchObject({ step: 1, hintsUsed: 1, speech: PLAN.steps[0]?.hint });
  });

  it("drops a check's unsafe words but keeps its verdict", async () => {
    const { store } = await startedOne();
    const { coach } = deps(store, {
      ...VERDICT,
      status: "off_track",
      redirect: "Close this and run the command in Command Prompt.",
      target: { point: { x: 10, y: 10 }, label: "Insert" },
    });
    const reply = await stepCoaching(
      { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "done", ...SCENE },
      coach,
    );
    expect(reply.speech).toBe("That's not quite where we're going. Click Insert, at the top.");
    expect(reply.actions[1]).toEqual({ type: "point_at", point: { x: 10, y: 10 } });
  });

  it("leaves the walkthrough as it is when the check fails, and says so", async () => {
    const { store, writes } = await startedOne();
    const { coach } = deps(store, new Error("timeout"));
    const reply = await stepCoaching(
      { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "done", ...SCENE },
      coach,
    );
    expect(reply).toMatchObject({ step: 1, speech: COACH_MESSAGES.checkFailed });
    expect(writes).toEqual([]);
  });

  it("lets a busy model through as such (the route answers 429)", async () => {
    const { store } = await startedOne();
    const { coach } = deps(store, new ModelBusyError("busy", 1000));
    await expect(
      stepCoaching(
        { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "stuck", ...SCENE },
        coach,
      ),
    ).rejects.toBeInstanceOf(ModelBusyError);
  });

  it("calls no model to pause, stop or confirm", async () => {
    const { store } = await startedOne();
    const { coach, generate } = deps(store);
    const id = "11111111-1111-4111-8111-111111111111";
    expect((await stepCoaching({ walkthroughId: id, event: "pause" }, coach)).status).toBe(
      "paused",
    );
    expect((await stepCoaching({ walkthroughId: id, event: "yes" }, coach)).status).toBe("paused");
    expect((await stepCoaching({ walkthroughId: id, event: "stop" }, coach)).status).toBe(
      "stopped",
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers 404 for a walkthrough that isn't the student's, and 409 when another event won", async () => {
    const { store } = await startedOne();
    const { coach } = deps(store, VERDICT);
    await expect(
      stepCoaching({ walkthroughId: "99999999-9999-4999-8999-999999999999", event: "stop" }, coach),
    ).rejects.toMatchObject({ status: 404 });

    const racing: WalkthroughStore = { ...store, update: () => Promise.resolve(null) };
    await expect(
      stepCoaching(
        { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "stop" },
        { ...coach, store: racing },
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("resuming", () => {
  it("checks the current step of the latest walkthrough on this screen", async () => {
    const { store } = await startedOne();
    await stepCoaching(
      { walkthroughId: "11111111-1111-4111-8111-111111111111", event: "stop" },
      deps(store).coach,
    );
    const { coach } = deps(store, { ...VERDICT, status: "not_completed" });
    const reply = await resumeCoaching(SCENE, coach);
    expect(reply).toMatchObject({
      status: "active",
      step: 1,
      hintsUsed: 0,
      speech: "Welcome back. Step 1: Click Insert, at the top.",
    });
  });

  it("says so when there's nothing to continue", async () => {
    const { coach, generate } = deps(memoryStore().store);
    const reply = await resumeCoaching(SCENE, coach);
    expect(reply).toMatchObject({ status: "declined", speech: COACH_MESSAGES.nothingToResume });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("a question in the middle of a walkthrough", () => {
  it("gets the walkthrough's title and current step, only while it's active", async () => {
    const { store } = await startedOne();
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await walkthroughContext(store, id)).toEqual({
      title: "Pivot tables",
      step: 1,
      instruction: "Click Insert, at the top.",
    });
    await stepCoaching({ walkthroughId: id, event: "pause" }, deps(store).coach);
    expect(await walkthroughContext(store, id)).toBeUndefined();
    const failing: WalkthroughStore = { ...store, get: () => Promise.reject(new Error("down")) };
    expect(await walkthroughContext(failing, id)).toBeUndefined();
  });
});
