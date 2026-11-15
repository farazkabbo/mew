import { describe, expect, it } from "vitest";

import { completedArrayItems, completedStringField } from "./partial-json";

/**
 * The streaming reader that lets neb speak before the model has finished (docs/PLAN.md, Part 2).
 * Fuzzed: the answer arrives split at every possible point, with brackets, quotes and escapes in
 * its strings, and with garbage, and it must never report something the full answer doesn't say.
 */
const ANSWER = JSON.stringify({
  steps: [
    { say: 'Look at mark 1: the "[x]" part.', actions: [{ type: "underline", box: [1, 2, 3] }] },
    { say: "Then {divide} both sides by 3 \\ carefully.", actions: [] },
    { say: "Nested ]]} brackets {[ in text.", actions: [{ type: "point_at", label: "a,b" }] },
  ],
  speech: 'She said "x = 4", then stopped.',
  summary: "Done.",
});
const FULL = JSON.parse(ANSWER) as { steps: unknown[]; speech: string };

describe("reading the answer while it streams", () => {
  it("never reports a field or step before it's complete, or anything the answer doesn't say", () => {
    for (let cut = 0; cut <= ANSWER.length; cut++) {
      const partial = ANSWER.slice(0, cut);
      const speech = completedStringField(partial, "speech");
      expect(speech === null || speech === FULL.speech).toBe(true);
      const steps = completedArrayItems(partial, "steps");
      expect(FULL.steps.slice(0, steps.length)).toEqual(steps);
    }
    expect(completedStringField(ANSWER, "speech")).toBe(FULL.speech);
    expect(completedArrayItems(ANSWER, "steps")).toEqual(FULL.steps);
  });

  it("each step appears once it's closed, in order, never later in a prefix", () => {
    let seen = 0;
    for (let cut = 0; cut <= ANSWER.length; cut++) {
      const count = completedArrayItems(ANSWER.slice(0, cut), "steps").length;
      expect(count).toBeGreaterThanOrEqual(seen);
      seen = count;
    }
    expect(seen).toBe(3);
  });

  it.each([
    "",
    "not json at all",
    '{"speech": ',
    '{"speech": "unterminated',
    '{"steps": [ {"say": "a"}, garbage',
    '{"steps": "not an array"}',
    "]]]}}}{{{[[[",
    '{"speech": 42}',
  ])("survives %j without throwing or inventing", (garbage) => {
    expect(() => completedStringField(garbage, "speech")).not.toThrow();
    expect(() => completedArrayItems(garbage, "steps")).not.toThrow();
    expect(completedStringField(garbage, "speech")).toBeNull();
  });
});

describe("a string field as far as it has arrived", () => {
  const FULL = { speech: "Typing it.", kind: "insert", text: 'Cats "purr".\n\tThey nap. 😺 é' };
  const RAW = JSON.stringify(FULL)
    .replace("é", String.raw`\u00e9`)
    .replace("😺", String.raw`\ud83d\ude3a`);

  it("only ever grows, and ends as the whole value", async () => {
    const { partialStringField } = await import("./partial-json");
    let seen = "";
    for (let cut = 0; cut <= RAW.length; cut++) {
      const got = partialStringField(RAW.slice(0, cut), "text");
      if (!got) continue;
      expect(got.value.startsWith(seen)).toBe(true);
      // Never half a surrogate pair.
      const last = got.value.charCodeAt(got.value.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      seen = got.value;
    }
    expect(seen).toBe(FULL.text);
    expect(partialStringField(RAW, "text")).toEqual({ value: FULL.text, done: true });
  });

  it("is null until the field starts, and survives rubbish", async () => {
    const { partialStringField } = await import("./partial-json");
    expect(partialStringField('{"speech": "hi", "kind": "ins', "text")).toBeNull();
    expect(partialStringField('{"text": "a\\', "text")).toEqual({ value: "a", done: false });
    expect(partialStringField('{"text": "a\\u00', "text")).toEqual({ value: "a", done: false });
    expect(partialStringField('{"text": "a\\uzzzzb', "text")).toEqual({ value: "ab", done: false });
    expect(partialStringField('{"text": 42}', "text")).toBeNull();
  });
});
