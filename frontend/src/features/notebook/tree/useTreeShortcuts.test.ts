import { describe, expect, it } from "vitest";

import { treeShortcut } from "./useTreeShortcuts";

const press = (
  code: string,
  mods: Partial<Record<"alt" | "ctrl" | "meta" | "shift", boolean>> = {},
  key = "",
) => ({
  code,
  key,
  altKey: mods.alt ?? false,
  ctrlKey: mods.ctrl ?? false,
  metaKey: mods.meta ?? false,
  shiftKey: mods.shift ?? false,
});

describe("treeShortcut", () => {
  it("knows the two-key shortcuts", () => {
    expect(treeShortcut(press("KeyB", { alt: true }), false)).toBe("newNotebook");
    expect(treeShortcut(press("KeyN", { alt: true }), false)).toBe("newChapter");
    expect(treeShortcut(press("KeyP", { alt: true }), false)).toBe("newPage");
    expect(treeShortcut(press("KeyK", { ctrl: true }), false)).toBe("jump");
    expect(treeShortcut(press("KeyK", { meta: true }), false)).toBe("jump");
    expect(treeShortcut(press("ArrowUp", { alt: true }), false)).toBe("up");
    expect(treeShortcut(press("F2", {}, "F2"), false)).toBe("rename");
  });

  it("takes Ctrl+N only in the desktop app (browsers keep it)", () => {
    expect(treeShortcut(press("KeyN", { ctrl: true }), true)).toBe("newNotebook");
    expect(treeShortcut(press("KeyN", { ctrl: true }), false)).toBeNull();
  });

  it("never fires on AltGr (Ctrl+Alt), three-key presses, or Alt+←/→", () => {
    expect(treeShortcut(press("KeyB", { alt: true, ctrl: true }), false)).toBeNull();
    expect(treeShortcut(press("KeyQ", { alt: true, ctrl: true }), false)).toBeNull();
    expect(treeShortcut(press("KeyB", { alt: true, shift: true }), false)).toBeNull();
    expect(treeShortcut(press("ArrowLeft", { alt: true }), false)).toBeNull();
    expect(treeShortcut(press("ArrowRight", { alt: true }), false)).toBeNull();
    expect(treeShortcut(press("KeyB"), false)).toBeNull();
  });
});
