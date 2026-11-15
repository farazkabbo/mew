import {
  isRiskyLabel,
  SCREEN_ACT_PROMPT,
  ScreenActReply,
  type ScreenActRequest,
} from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ screenModel: () => "test-model" }));

import { actOnScreen, SCREEN_ACT_MESSAGES, type ScreenActDeps } from "./screen-act";

const TURN = "33333333-3333-4333-8333-333333333333";
const ACT: ScreenActRequest = {
  goal: "open the insert tab",
  app: "winword.exe",
  scope: "monitor",
  history: [],
  image: { jpeg: "/9j/AA==", width: 800, height: 600 },
};

function deps(made: unknown): ScreenActDeps & { inputs: unknown[] } {
  const inputs: unknown[] = [];
  return {
    inputs,
    generate: <T>(request: { input: unknown }) => {
      inputs.push(request.input);
      return Promise.resolve(made as T);
    },
    newTurnId: () => TURN,
  } as ScreenActDeps & { inputs: unknown[] };
}

const click = (label: string) => ({
  type: "click" as const,
  point: { x: 120, y: 40 },
  label,
  button: "left" as const,
  double: false,
});

describe("Neb's hand: the next action", () => {
  it("passes on one action and what to say, with the goal and history sent to the model", async () => {
    const made = deps({ speech: "Opening the Insert tab.", action: click("Insert") });
    const reply = await actOnScreen(
      { ...ACT, history: ["Clicked Home."] },
      undefined,
      undefined,
      made,
    );
    expect(ScreenActReply.parse(reply)).toEqual({
      speech: "Opening the Insert tab.",
      action: click("Insert"),
      turnId: TURN,
    });
    const [text] = made.inputs[0] as [{ text: string }];
    expect(JSON.parse(text.text)).toMatchObject({
      goal: "open the insert tab",
      doneSoFar: ["Clicked Home."],
    });
  });

  it.each(["Buy now", "Send", "Delete account", "Sign in", "Place order", "Accept all", "Install"])(
    "never presses %s: it stops and says the button is the student's",
    async (label) => {
      const reply = await actOnScreen(
        ACT,
        undefined,
        undefined,
        deps({ speech: "Pressing it.", action: click(label) }),
      );
      expect(reply.action).toEqual({ type: "stop" });
      expect(reply.speech).toBe(SCREEN_ACT_MESSAGES.risky(label));
    },
  );

  it("knows an ordinary control from one that's the student's to press", () => {
    for (const label of ["Insert", "Bold", "Save as", "Table", "File", "Next slide", "Search"]) {
      expect(isRiskyLabel(label), label).toBe(false);
    }
    for (const label of ["PAY", "Log in", "Remove", "Confirm purchase", "Post", "Reset"]) {
      expect(isRiskyLabel(label), label).toBe(true);
    }
  });

  it("stops rather than say or type something that fails the safety check", async () => {
    for (const made of [
      { speech: "Enter your password: hunter2", action: click("Insert") },
      { speech: "Typing it.", action: { type: "type", text: "Enter your password: hunter2" } },
    ]) {
      const reply = await actOnScreen(ACT, undefined, undefined, deps(made));
      expect(reply).toEqual({
        speech: SCREEN_ACT_MESSAGES.unsafe,
        action: { type: "stop" },
        turnId: TURN,
      });
    }
  });

  it("hands over to the typing when the goal asks for a passage", async () => {
    const action = { type: "write" as const, request: "an essay on cats" };
    const reply = await actOnScreen(
      { ...ACT, goal: "open a blank document and then write an essay on cats" },
      undefined,
      undefined,
      deps({ speech: "The document's ready. Writing your essay.", action }),
    );
    expect(ScreenActReply.parse(reply).action).toEqual(action);
  });

  it("says the model is unavailable when it fails", async () => {
    const failing = {
      generate: () => Promise.reject(new Error("down")),
      newTurnId: () => TURN,
    } as unknown as ScreenActDeps;
    await expect(actOnScreen(ACT, undefined, undefined, failing)).rejects.toMatchObject({
      status: 503,
    });
  });

  it("tells the model what it must leave to the student", () => {
    for (const word of ["buys", "sends", "deletes", "signs in", "passwords", "terminal"]) {
      expect(SCREEN_ACT_PROMPT.system).toContain(word);
    }
  });
});
