import { describe, expect, it } from "vitest";

import { fuzzyScore } from "./fuzzy";

describe("fuzzyScore", () => {
  it("matches characters in order, and nothing else", () => {
    expect(fuzzyScore("phy", "Physics")).toBeGreaterThan(0);
    expect(fuzzyScore("pkm", "Physics › Kinematics")).toBeGreaterThan(0);
    expect(fuzzyScore("yhp", "Physics")).toBe(0);
    expect(fuzzyScore("", "Anything")).toBeGreaterThan(0);
  });

  it("prefers word starts, runs and whole words", () => {
    const kinematics = fuzzyScore("kin", "Physics › Kinematics");
    const scattered = fuzzyScore("kin", "Physics › Making notes");
    expect(kinematics).toBeGreaterThan(scattered);
    expect(fuzzyScore("forces", "Forces")).toBeGreaterThan(fuzzyScore("forces", "Fluid orces"));
  });

  it("ignores case and accents", () => {
    expect(fuzzyScore("ecole", "École")).toBeGreaterThan(0);
  });
});
