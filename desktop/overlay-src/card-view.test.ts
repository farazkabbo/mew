import { describe, expect, it } from "vitest";

import { cardLayout } from "./card-view";

describe("the Circle & Ask card", () => {
  it("asks, with the voice hint unless silent", () => {
    const ask = cardLayout({ mode: "ask", silent: false });
    expect(ask?.top).toContain("Ctrl+Alt+Space");
    expect(ask?.input).toMatchObject({ placeholder: "Ask about this…", action: "ask" });
    expect(ask?.buttons.map((b) => b.label)).toEqual(["Select question on screen", "Explain ↵"]);
    expect(cardLayout({ mode: "ask", silent: true })?.top).toBe(
      "Type a question, or just press Enter",
    );
  });

  it("captions a step with its controls", () => {
    const step = cardLayout({
      mode: "explain",
      step: 2,
      total: 3,
      say: "So it's flat.",
      paused: false,
    });
    expect(step).toMatchObject({ top: "Step 2 of 3", text: "So it's flat." });
    expect(step?.buttons.map((b) => b.action)).toEqual(["pause", "repeat", "next", "stop"]);
    const paused = cardLayout({ mode: "explain", step: 2, total: 3, say: "x", paused: true });
    expect(paused?.top).toBe("Step 2 of 3 · paused");
    expect(paused?.buttons[0]).toMatchObject({ action: "resume", primary: true });
  });

  it("counts the save toast down, with Undo, Edit crop and Open", () => {
    const toast = cardLayout({
      mode: "toast",
      seconds: 5,
      canSave: true,
      followUp: "What's a here?",
    });
    expect(toast).toMatchObject({ countdown: 5, top: "✓ Saving to your notebook · From screen" });
    expect(toast?.buttons.map((b) => b.action)).toEqual(["undo", "edit_crop", "open"]);
    expect(toast?.text).toBe("To check: What's a here?");
    // "Ask each time": nothing counts down; the student saves.
    const asking = cardLayout({ mode: "toast", seconds: null, canSave: true });
    expect(asking?.countdown).toBeNull();
    expect(asking?.buttons[0]).toMatchObject({ action: "save" });
    // A protected picture can't be saved.
    const blocked = cardLayout({
      mode: "toast",
      seconds: null,
      canSave: false,
      note: "Protected.",
    });
    expect(blocked?.buttons.map((b) => b.action)).toEqual(["close"]);
    expect(blocked?.text).toBe("Protected.");
  });

  it("shows a question read from the screen back, or lets the student pick one", () => {
    const one = cardLayout({ mode: "confirm", questions: ["Find x"] });
    expect(one).toMatchObject({ top: "I read this. Is it right?", chips: [] });
    expect(one?.input).toMatchObject({ value: "Find x", action: "confirm" });
    const two = cardLayout({ mode: "confirm", questions: ["Find x", "Find y"] });
    expect(two?.chips).toEqual(["Find x", "Find y"]);
  });

  it("refuses anything malformed", () => {
    for (const bad of [
      null,
      { mode: "hack" },
      { mode: "explain", step: 0, total: 1, say: "x" },
      { mode: "explain", step: 1, total: 1, say: "x".repeat(221) },
      { mode: "confirm", questions: [] },
      { mode: "message", text: "" },
    ]) {
      expect(cardLayout(bad)).toBeNull();
    }
  });
});
