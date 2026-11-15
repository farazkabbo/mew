import { SCREEN_INTENT_PROMPT, SCREEN_INTENTS, type ScreenIntentRequest } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ screenModel: () => "test-model" }));

import { intentForScreen, type ScreenIntentDeps } from "./screen-intent";

const SAID: ScreenIntentRequest = {
  transcript: "write a 100 word essay on cats",
  app: "winword.exe",
  coaching: false,
  hasInk: false,
};

function deps(intent: string): ScreenIntentDeps & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    generate: <T>(request: { input: unknown }) => {
      inputs.push(request.input);
      return Promise.resolve({ intent } as T);
    },
  } as ScreenIntentDeps & { inputs: unknown[] };
}

describe("what the student meant", () => {
  it("passes on the model's reading, from the words alone", async () => {
    const made = deps("write");
    expect(await intentForScreen(SAID, undefined, made)).toEqual({ intent: "write" });
    // Words and three facts: no image goes with it.
    expect(made.inputs).toEqual([
      [
        {
          type: "text",
          text: JSON.stringify({
            said: SAID.transcript,
            app: "winword.exe",
            coaching: false,
            hasInk: false,
          }),
        },
      ],
    ]);
  });

  it("turns a walkthrough's reply into a question when there's no walkthrough", async () => {
    expect(await intentForScreen(SAID, undefined, deps("coach_done"))).toEqual({ intent: "ask" });
    expect(
      await intentForScreen({ ...SAID, coaching: true }, undefined, deps("coach_done")),
    ).toEqual({ intent: "coach_done" });
    // Starting one needs no walkthrough in progress.
    expect(await intentForScreen(SAID, undefined, deps("coach_start"))).toEqual({
      intent: "coach_start",
    });
  });

  it("only shows ink again when there is some", async () => {
    expect(await intentForScreen(SAID, undefined, deps("reannotate"))).toEqual({ intent: "ask" });
    expect(await intentForScreen({ ...SAID, hasInk: true }, undefined, deps("reannotate"))).toEqual(
      { intent: "reannotate" },
    );
  });

  it("says the model is unavailable when it fails, so the desktop app uses its own rules", async () => {
    const failing = {
      generate: () => Promise.reject(new Error("down")),
    } as unknown as ScreenIntentDeps;
    await expect(intentForScreen(SAID, undefined, failing)).rejects.toMatchObject({ status: 503 });
  });

  it("describes every intent it may answer with", () => {
    for (const intent of SCREEN_INTENTS) {
      expect(SCREEN_INTENT_PROMPT.system).toContain(`"${intent}"`);
    }
  });
});
