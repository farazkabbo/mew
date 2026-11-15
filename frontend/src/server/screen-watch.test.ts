import type { ScreenWatchRequest, ScreenWriteRequest } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ screenModel: () => "test-model" }));

import { watchScreen, type ScreenWatchDeps } from "./screen-watch";
import { SCREEN_WRITE_MESSAGES, writeForScreen, type ScreenWriteDeps } from "./screen-write";

const TURN = "33333333-3333-4333-8333-333333333333";
const IMAGE = { jpeg: "/9j/AA==", width: 800, height: 600 };
const BOX = { left: 100, top: 100, right: 400, bottom: 200 };

const WATCH: ScreenWatchRequest = {
  app: "onenote.exe",
  scope: "monitor",
  help: "coach",
  image: IMAGE,
};
const WRITE: ScreenWriteRequest = {
  transcript: "rewrite this sentence so it's shorter",
  app: "winword.exe",
  scope: "window",
  image: IMAGE,
};

function deps(made: unknown): ScreenWatchDeps & ScreenWriteDeps & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    generate: <T>(request: { input: unknown }) => {
      inputs.push(request.input);
      return Promise.resolve(made as T);
    },
    newTurnId: () => TURN,
  } as ScreenWatchDeps & ScreenWriteDeps & { inputs: unknown[] };
}

describe("watching the screen", () => {
  it("stays quiet when the working is fine or there's none", async () => {
    for (const status of ["fine", "nothing"] as const) {
      const reply = await watchScreen(
        WATCH,
        undefined,
        undefined,
        deps({ status, speech: "", actions: [] }),
      );
      expect(reply).toEqual({ status });
    }
  });

  it("says a mistake, with its ink anchored on a focus region", async () => {
    const d = deps({
      status: "mistake",
      speech: "Check line two: 3x is 12, not 26.",
      actions: [{ type: "circle_region", box: BOX }],
    });
    const reply = await watchScreen(WATCH, undefined, undefined, d);
    expect(reply).toMatchObject({ status: "mistake", turnId: TURN });
    if (reply.status !== "mistake") throw new Error("expected a mistake");
    expect(reply.actions[0]?.type).toBe("focus_region");
    // The help level goes to the model.
    expect(JSON.stringify(d.inputs[0])).toContain('\\"help\\":\\"coach\\"');
  });

  it("drops an unsafe reply instead of saying it", async () => {
    const reply = await watchScreen(
      WATCH,
      undefined,
      undefined,
      deps({ status: "mistake", speech: "Type your password here to fix it.", actions: [] }),
    );
    expect(reply).toEqual({ status: "fine" });
  });
});

describe("typing into a document", () => {
  it("returns the text to type and what to say first", async () => {
    const reply = await writeForScreen(
      WRITE,
      undefined,
      undefined,
      deps({
        speech: "Here's a shorter version.",
        kind: "replace",
        text: "Cells divide.\r\nThen grow.",
      }),
    );
    expect(reply).toEqual({
      speech: "Here's a shorter version.",
      kind: "replace",
      text: "Cells divide.\nThen grow.",
      turnId: TURN,
    });
  });

  it("types nothing when the reply fails the safety check", async () => {
    const reply = await writeForScreen(
      WRITE,
      undefined,
      undefined,
      deps({ speech: "Typing it now.", kind: "insert", text: "Enter your password: hunter2" }),
    );
    expect(reply).toMatchObject({ speech: SCREEN_WRITE_MESSAGES.unsafe, text: "" });
  });
});
