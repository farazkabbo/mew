import type { ScreenWatchRequest } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ screenModel: () => "test-model" }));

import { watchScreen, type ScreenWatchDeps } from "./screen-watch";

const TURN = "33333333-3333-4333-8333-333333333333";
const IMAGE = { jpeg: "/9j/AA==", width: 800, height: 600 };
const BOX = { left: 100, top: 100, right: 400, bottom: 200 };

const WATCH: ScreenWatchRequest = {
  app: "onenote.exe",
  scope: "monitor",
  help: "coach",
  image: IMAGE,
};

function deps(made: unknown): ScreenWatchDeps & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    generate: <T>(request: { input: unknown }) => {
      inputs.push(request.input);
      return Promise.resolve(made as T);
    },
    newTurnId: () => TURN,
  } as ScreenWatchDeps & { inputs: unknown[] };
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
