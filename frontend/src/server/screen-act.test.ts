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
  mode: "do",
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
      mode: "do",
      doneSoFar: ["Clicked Home."],
    });
  });

  it.each(["Buy now", "Send", "Delete account", "Sign in", "Place order", "Accept all", "Install"])(
    "never presses %s: it points at it and says the button is the student's",
    async (label) => {
      const reply = await actOnScreen(
        ACT,
        undefined,
        undefined,
        deps({ speech: "Pressing it.", action: click(label) }),
      );
      expect(ScreenActReply.parse(reply).action).toEqual({
        type: "point",
        point: { x: 120, y: 40 },
        label,
      });
      expect(reply.speech).toBe(SCREEN_ACT_MESSAGES.risky(label));
    },
  );

  describe("show me where", () => {
    const SHOW: ScreenActRequest = {
      ...ACT,
      goal: "where can I sign out in vs code?",
      app: "code.exe",
      mode: "show",
    };

    it("tells the model they asked where, not for it to be done", async () => {
      const made = deps({ speech: "Opening your account menu.", action: click("Accounts") });
      const reply = await actOnScreen(SHOW, undefined, undefined, made);
      expect(reply.action).toEqual(click("Accounts"));
      const [text] = made.inputs[0] as [{ text: string }];
      expect(JSON.parse(text.text)).toMatchObject({ mode: "show" });
      expect(SCREEN_ACT_PROMPT.system).toContain("They did not ask you to do it");
    });

    it("ends with the cursor resting on the thing", async () => {
      const action = { type: "point" as const, point: { x: 60, y: 900 }, label: "Sign Out" };
      const reply = await actOnScreen(
        SHOW,
        undefined,
        undefined,
        deps({ speech: "Sign out is here, under your profile picture.", action }),
      );
      expect(ScreenActReply.parse(reply)).toMatchObject({
        speech: "Sign out is here, under your profile picture.",
        action,
      });
    });

    it("points even if the model went to press what they asked about", async () => {
      const reply = await actOnScreen(
        SHOW,
        undefined,
        undefined,
        deps({ speech: "Signing you out.", action: click("Sign Out") }),
      );
      expect(reply.action).toEqual({ type: "point", point: { x: 120, y: 40 }, label: "Sign Out" });
      expect(reply.speech).toBe(SCREEN_ACT_MESSAGES.here("Sign Out"));
    });

    it("never writes", async () => {
      const reply = await actOnScreen(
        SHOW,
        undefined,
        undefined,
        deps({ speech: "Writing.", action: { type: "write", request: "an essay" } }),
      );
      expect(reply).toMatchObject({ speech: SCREEN_ACT_MESSAGES.shown, action: { type: "stop" } });
    });
  });

  describe("a long task", () => {
    const LONG: ScreenActRequest = {
      ...ACT,
      goal: "research the water cycle and save it in a doc",
      app: "msedge.exe",
      history: ["Pressed Ctrl+L.", "Typed “water cycle”.", "Pressed Enter."],
      plan: "1. Open two sources. 2. Note the facts. 3. Write it up in Word. 4. Save.",
      notes: ["Evaporation: the sun heats water into vapour. (USGS, usgs.gov/water-cycle)"],
    };

    it("gives the model its plan and notes, and passes the new ones back", async () => {
      const made = deps({
        plan: "1. Open one more source. 2. Write it up in Word. 3. Save.",
        note: "Condensation: vapour cools into clouds. (NOAA, noaa.gov/water-cycle)",
        speech: "Reading this page on condensation.",
        action: { type: "scroll", point: { x: 500, y: 500 }, direction: "down", amount: 8 },
      });
      const reply = await actOnScreen(LONG, undefined, undefined, made);
      expect(ScreenActReply.parse(reply)).toMatchObject({
        plan: "1. Open one more source. 2. Write it up in Word. 3. Save.",
        note: "Condensation: vapour cools into clouds. (NOAA, noaa.gov/water-cycle)",
        action: { type: "scroll" },
      });
      const [text] = made.inputs[0] as [{ text: string }];
      expect(JSON.parse(text.text)).toMatchObject({ plan: LONG.plan, notes: LONG.notes });
    });

    it("leaves an empty plan or note out", async () => {
      const reply = await actOnScreen(
        LONG,
        undefined,
        undefined,
        deps({ plan: " ", note: "", speech: "Done.", action: { type: "done" } }),
      );
      expect(reply).not.toHaveProperty("plan");
      expect(reply).not.toHaveProperty("note");
    });

    it("stops rather than keep a note that fails the safety check", async () => {
      const reply = await actOnScreen(
        LONG,
        undefined,
        undefined,
        deps({
          note: "Enter your password: hunter2",
          speech: "Reading.",
          action: { type: "wait" },
        }),
      );
      expect(reply).toEqual({
        speech: SCREEN_ACT_MESSAGES.unsafe,
        action: { type: "stop" },
        turnId: TURN,
      });
    });

    it("tells the model how to find its way and what to remember", () => {
      for (const words of [
        "only memory",
        "Sources",
        "Never accept or agree",
        "change course",
        "at least eight notes from at least three sources",
        "Untitled document",
        "only once it's visibly open",
      ]) {
        expect(SCREEN_ACT_PROMPT.system).toContain(words);
      }
    });
  });

  describe("opening an app or a site", () => {
    it("passes on an app's name and an https address", async () => {
      for (const action of [
        { type: "open", what: "app", target: "Google Chrome" },
        { type: "open", what: "site", target: "https://www.google.com/search?q=water+cycle" },
        { type: "open", what: "site", target: "https://docs.new" },
      ]) {
        const reply = await actOnScreen(
          ACT,
          undefined,
          undefined,
          deps({ speech: "Opening it.", action }),
        );
        expect(ScreenActReply.parse(reply).action).toEqual(action);
      }
    });

    it.each([
      "http://example.com",
      "file:///C:/Windows/System32/cmd.exe",
      "javascript:alert(1)",
      "ms-settings:privacy",
      "https://user:pass@example.com/",
      "https://example.com@evil.example/",
      "https://localhost/",
      "https://exa mple.com/",
      "C:\\Windows\\System32\\calc.exe",
    ])("never opens %s", async (target) => {
      const reply = await actOnScreen(
        ACT,
        undefined,
        undefined,
        deps({ speech: "Opening it.", action: { type: "open", what: "site", target } }),
      );
      // Refused as an address, or before that by the safety check: a stop either way.
      expect(reply.action).toEqual({ type: "stop" });
      expect([SCREEN_ACT_MESSAGES.address, SCREEN_ACT_MESSAGES.unsafe]).toContain(reply.speech);
    });

    it("tells the model a browser needn't be running", () => {
      expect(SCREEN_ACT_PROMPT.system).toContain("No browser running is not a problem");
      // Guessed addresses are dead links: it searches and clicks a result instead.
      expect(SCREEN_ACT_PROMPT.system).toContain("Never make up the address of a page");
      expect(SCREEN_ACT_PROMPT.system).toContain("A dead end");
    });
  });

  it("passes on a shortcut and a wait", async () => {
    for (const action of [{ type: "key", key: "ctrl+l" }, { type: "wait" }]) {
      const reply = await actOnScreen(
        ACT,
        undefined,
        undefined,
        deps({ speech: "One moment.", action }),
      );
      expect(ScreenActReply.parse(reply).action).toEqual(action);
    }
    // Nothing that closes, deletes, pastes or runs is a key at all.
    for (const key of ["alt+f4", "ctrl+w", "delete", "ctrl+v", "ctrl+enter", "win+r"]) {
      const parsed = ScreenActReply.safeParse({
        speech: "x",
        action: { type: "key", key },
        turnId: TURN,
      });
      expect(parsed.success, key).toBe(false);
    }
  });

  describe("the first hand (desktop 0.1.5, which sends no mode)", () => {
    const FIRST: ScreenActRequest = { ...ACT, mode: undefined };

    it("is answered only with what it knows", async () => {
      const point = { type: "point", point: { x: 1, y: 2 }, label: "Insert" };
      const cases: [unknown, string][] = [
        [{ ...point }, "Here."],
        [{ type: "wait" }, SCREEN_ACT_MESSAGES.needsUpdate],
        [{ type: "open", what: "app", target: "Word" }, SCREEN_ACT_MESSAGES.needsUpdate],
        [{ type: "key", key: "ctrl+l" }, SCREEN_ACT_MESSAGES.needsUpdate],
        [click("Send"), SCREEN_ACT_MESSAGES.risky("Send")],
      ];
      for (const [action, speech] of cases) {
        const reply = await actOnScreen(
          FIRST,
          undefined,
          undefined,
          deps({ speech: "Here.", action }),
        );
        expect(reply).toMatchObject({ speech, action: { type: "stop" } });
      }
      const enter = { type: "key", key: "enter" };
      const reply = await actOnScreen(
        FIRST,
        undefined,
        undefined,
        deps({ plan: "1. Next.", note: "A fact.", speech: "Here.", action: enter }),
      );
      expect(reply.action).toEqual(enter);
      expect(reply).not.toHaveProperty("plan");
      expect(reply).not.toHaveProperty("note");
    });
  });

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
