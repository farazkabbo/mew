import { describe, expect, it } from "vitest";

import { stepsFor, TOUR_STEPS } from "./Tour";

describe("the tour (decision U31)", () => {
  it("shows the taskbar step in the Windows app only", () => {
    expect(stepsFor(true).map((s) => s.id)).toEqual(TOUR_STEPS.map((s) => s.id));
    expect(stepsFor(false).map((s) => s.id)).not.toContain("tray");
    expect(stepsFor(false)).toHaveLength(TOUR_STEPS.length - 1);
  });

  it("covers what a new student asked about, in the order they meet it", () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      "welcome",
      "desk",
      "marks",
      "talk",
      "circle",
      "save",
      "tray",
      "quiz",
      "done",
    ]);
  });

  it("gives every practice step a task, and the first and last nothing to do", () => {
    for (const step of TOUR_STEPS) expect(Boolean(step.Stage), step.id).toBe(Boolean(step.task));
    expect(TOUR_STEPS[0]?.Stage).toBeUndefined();
    expect(TOUR_STEPS.at(-1)?.Stage).toBeUndefined();
  });
});
