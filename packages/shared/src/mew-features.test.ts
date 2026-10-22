import { describe, expect, it } from "vitest";

import { MewInput } from "./mew";
import { mewFeatureText } from "./mew-features";
import cases from "./mew-features.cases.json";

type Case = {
  name: string;
  input: unknown;
  text: string | null;
  expectLength?: { utteranceChars: number; endsWith: string };
};

/** Shared with the Python implementation (backend/tests/test_dataset.py). */
const CASES = cases as Case[];

describe("mewFeatureText", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const text = mewFeatureText(MewInput.parse(c.input));
    if (c.text !== null) {
      expect(text).toBe(c.text);
      return;
    }
    const said = text.split(" | ")[0] ?? "";
    expect(Array.from(MewInput.parse(c.input).lastUtterance).length).toBeGreaterThan(300);
    expect(Array.from(said)).toHaveLength(c.expectLength?.utteranceChars ?? 0);
    expect(said.endsWith(c.expectLength?.endsWith ?? "")).toBe(true);
    expect(said).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/); // no split emoji
  });
});
