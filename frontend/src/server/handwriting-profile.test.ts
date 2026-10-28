import type { HandwritingSample } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { forgetSamples, profileForRecognition, samplesFor, summarize } from "./handwriting-profile";

vi.mock("./user-api", () => ({ userApi: vi.fn() }));

const sample = (n: number, fields: Partial<HandwritingSample> = {}): HandwritingSample => ({
  id: `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`,
  text: "x = 7",
  latex: "x = 7",
  readAs: "x = 1",
  source: "fix",
  image: `iVBORw0KGgo${n}`,
  createdAt: n,
  ...fields,
});

describe("the handwriting profile on the server", () => {
  it("reads a student's samples at most every few minutes, and again after a change", async () => {
    const load = vi.fn(() => Promise.resolve([sample(1)]));
    await samplesFor("u1", load, 0);
    await samplesFor("u1", load, 60_000);
    expect(load).toHaveBeenCalledTimes(1);
    await samplesFor("u1", load, 10 * 60_000);
    expect(load).toHaveBeenCalledTimes(2);
    forgetSamples("u1");
    await samplesFor("u1", load, 10 * 60_000 + 1);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("still recognises when the profile can't be read", async () => {
    const samples = await samplesFor("u2", () => Promise.reject(new Error("down")), 0);
    expect(samples).toEqual([]);
    expect(profileForRecognition(samples)).toEqual({ examples: [], note: null });
  });

  it("gives examples, and a note once a look-alike is seen twice", () => {
    const one = profileForRecognition([sample(1)]);
    expect(one.examples).toEqual([{ image: "iVBORw0KGgo1", text: "x = 7" }]);
    expect(one.note).toBeNull();
    const two = profileForRecognition([sample(1), sample(2, { text: "7 + 1", readAs: "1 + 1" })]);
    expect(two.note).toContain(`"7" can look like "1"`);
    // A calibrated student gets the note from the first time.
    const calibrated = profileForRecognition([sample(1), sample(3, { source: "calibration" })]);
    expect(calibrated.note).toContain(`"7"`);
  });

  it("summarizes without the pictures", () => {
    const summary = summarize([sample(1), sample(2, { source: "calibration", readAs: null })]);
    expect(summary).toEqual({
      learned: 2,
      confusions: [{ read: "1", meant: "7", count: 1 }],
      calibrated: true,
    });
  });
});
