import { describe, expect, it } from "vitest";

import { type CardLayout, cardKey, cardLayout, filterPlaces } from "./card-view";

describe("the Circle & Ask card", () => {
  it("asks, with the voice hint unless silent", () => {
    const ask = cardLayout({ mode: "ask", silent: false });
    expect(ask?.top).toBe("Hold Ctrl+Alt to ask out loud");
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

  it("counts the save toast down, with Undo, Change, Edit crop and Open", () => {
    const toast = cardLayout({
      mode: "toast",
      seconds: 5,
      canSave: true,
      followUp: "What's a here?",
    });
    expect(toast).toMatchObject({ countdown: 5, top: "✓ Saving to your notebook · From screen" });
    expect(toast?.buttons.map((b) => b.action)).toEqual([
      "undo",
      "change_place",
      "edit_crop",
      "open",
    ]);
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

  it("takes two-key shortcuts only (K2)", () => {
    const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({
      key: k,
      code: k.length === 1 ? `Key${k.toUpperCase()}` : k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    const ask = cardLayout({ mode: "ask", silent: false }) as CardLayout;
    const explain = cardLayout({ mode: "explain", step: 1, total: 3, say: "First." }) as CardLayout;
    const paused = cardLayout({
      mode: "explain",
      step: 1,
      total: 3,
      say: "First.",
      paused: true,
    }) as CardLayout;
    const toast = cardLayout({ mode: "toast", seconds: null }) as CardLayout;

    expect(cardKey(key("s", { ctrlKey: true }), ask, false)).toBe("save_only");
    expect(cardKey(key("s", { ctrlKey: true }), ask, true)).toBe("save_only");
    expect(cardKey(key("s", { ctrlKey: true }), toast, false)).toBe("save");
    // Three keys never count.
    expect(cardKey(key("s", { ctrlKey: true, shiftKey: true }), ask, false)).toBeNull();
    expect(cardKey(key("s", { ctrlKey: true, altKey: true }), ask, false)).toBeNull();

    expect(cardKey(key("ArrowRight"), explain, false)).toBe("next");
    expect(cardKey(key("ArrowLeft"), explain, false)).toBe("repeat");
    expect(cardKey(key(" "), explain, false)).toBe("pause");
    expect(cardKey(key(" "), paused, false)).toBe("resume");
    // Typing a follow-up keeps the arrows and Space for the text box.
    expect(cardKey(key("ArrowLeft"), explain, true)).toBeNull();
    expect(cardKey(key(" "), explain, true)).toBeNull();
    // The step keys mean nothing outside an explanation.
    expect(cardKey(key("ArrowRight"), ask, false)).toBeNull();

    expect(cardKey(key("Escape"), explain, true)).toBe("stop");
    expect(cardKey(key("Escape"), ask, false)).toBe("close");
    expect(cardKey(key("Enter"), ask, false)).toBeNull(); // the form's own submit
    expect(cardKey(key("Escape"), null, false)).toBeNull();
  });

  it("says where it's saved, and offers places to choose (K3)", () => {
    const saved = cardLayout({
      mode: "toast",
      seconds: 5,
      canSave: true,
      place: { label: "Physics › Chapter 5", choices: [], create: null },
    });
    expect(saved?.top).toBe("✓ Saving to Physics › Chapter 5");
    expect(saved?.place).toEqual({
      line: "Saving to: Physics › Chapter 5",
      chips: [{ label: "Change ▾", action: "change_place" }],
    });
    // Close candidates: chips, never a guess.
    const choose = cardLayout({
      mode: "explain",
      step: 1,
      total: 2,
      say: "First.",
      place: { label: null, choices: ["Physics › Chapter 1", "Physics II › Chapter 1"] },
    });
    expect(choose?.place?.line).toBe("Save it to which one?");
    expect(choose?.place?.chips).toEqual([
      { label: "Physics › Chapter 1", action: "pick_place", index: 0 },
      { label: "Physics II › Chapter 1", action: "pick_place", index: 1 },
      { label: "Pick another…", action: "change_place" },
    ]);
    // A chapter that isn't there yet: offered, made only on the tap.
    const missing = cardLayout({
      mode: "ask",
      place: { label: null, choices: [], create: "Physics › Chapter 5" },
    });
    expect(missing?.place?.line).toBe("There's no Physics › Chapter 5 yet.");
    expect(missing?.place?.chips[0]).toEqual({
      label: "Create Physics › Chapter 5 and save",
      action: "create_place",
    });
    // Without a place, nothing about places shows; saved says where.
    expect(cardLayout({ mode: "ask" })?.place).toBeNull();
    expect(cardLayout({ mode: "saved", place: { label: "Biology" } })?.top).toBe(
      "✓ Saved to Biology",
    );
  });

  it("filters the picker's places as the student types (K3)", () => {
    const picker = cardLayout({
      mode: "place",
      places: ["Physics", "Physics › Chapter 1 · Kinematics", "Chemistry › Unit 2"],
    }) as CardLayout;
    expect(picker.chips).toHaveLength(3);
    expect(filterPlaces(picker.chips, "phys kin")).toEqual([1]);
    expect(filterPlaces(picker.chips, "")).toEqual([0, 1, 2]);
    expect(filterPlaces(picker.chips, "UNIT")).toEqual([2]);
    const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
      key: "",
      code,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    });
    expect(cardKey({ ...key("Escape"), key: "Escape" }, picker, false)).toBe("place_cancel");
    const ask = cardLayout({ mode: "ask", place: { label: "Physics" } }) as CardLayout;
    expect(cardKey(key("KeyD", { ctrlKey: true }), ask, false)).toBe("change_place");
    expect(cardKey(key("KeyD", { ctrlKey: true }), cardLayout({ mode: "ask" }), false)).toBeNull();
  });
});
