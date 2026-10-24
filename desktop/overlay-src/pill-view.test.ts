import { describe, expect, it } from "vitest";

import { parsePillView } from "./pill-view";

describe("the progress pill's view", () => {
  it("accepts what Rust sends", () => {
    const view = { title: "Pivot tables", progress: "Step 3 of ~7", state: "awaiting" };
    expect(parsePillView(view)).toEqual(view);
    const finished = {
      ...view,
      progress: "",
      state: "finished",
      summary: "You did it with 1 hint.",
    };
    expect(parsePillView(finished)).toEqual(finished);
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "Step 3",
      { title: "Pivot tables", progress: "Step 3 of ~7", state: "skipping" },
      { title: "x".repeat(61), progress: "", state: "awaiting" },
      { title: "Pivot tables", progress: 3, state: "awaiting" },
      { title: "Pivot tables", progress: "", state: "finished", summary: { html: "<b>" } },
    ]) {
      expect(parsePillView(bad)).toBeNull();
    }
  });
});
