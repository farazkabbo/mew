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
    expect(treeShortcut(press("KeyB", { alt: true }), "browser")).toBe("newNotebook");
    expect(treeShortcut(press("KeyN", { alt: true }), "browser")).toBe("newChapter");
    expect(treeShortcut(press("KeyP", { alt: true }), "browser")).toBe("newPage");
    expect(treeShortcut(press("KeyK", { ctrl: true }), "browser")).toBe("jump");
    expect(treeShortcut(press("KeyK", { meta: true }), "browser")).toBe("jump");
    expect(treeShortcut(press("ArrowUp", { alt: true }), "browser")).toBe("up");
    expect(treeShortcut(press("F2", {}, "F2"), "browser")).toBe("rename");
  });

  it("takes Ctrl+N only in the desktop app (browsers keep it)", () => {
    expect(treeShortcut(press("KeyN", { ctrl: true }), "desktop")).toBe("newNotebook");
    expect(treeShortcut(press("KeyN", { ctrl: true }), "browser")).toBeNull();
    // Alt+B works in the desktop app too.
    expect(treeShortcut(press("KeyB", { alt: true }), "desktop")).toBe("newNotebook");
  });

  it("never fires on AltGr (Ctrl+Alt), three-key presses, or Alt+←/→", () => {
    expect(treeShortcut(press("KeyB", { alt: true, ctrl: true }), "browser")).toBeNull();
    expect(treeShortcut(press("KeyQ", { alt: true, ctrl: true }), "browser")).toBeNull();
    expect(treeShortcut(press("KeyB", { alt: true, shift: true }), "browser")).toBeNull();
    expect(treeShortcut(press("ArrowLeft", { alt: true }), "browser")).toBeNull();
    expect(treeShortcut(press("ArrowRight", { alt: true }), "browser")).toBeNull();
    expect(treeShortcut(press("KeyB"), "browser")).toBeNull();
  });

  it("follows the student's own bindings", () => {
    const own = { new_chapter: "Alt+J", rename: "Alt+R" };
    expect(treeShortcut(press("KeyJ", { alt: true }), "browser", own)).toBe("newChapter");
    expect(treeShortcut(press("KeyN", { alt: true }), "browser", own)).toBeNull();
    expect(treeShortcut(press("KeyR", { alt: true }), "browser", own)).toBe("rename");
    expect(treeShortcut(press("F2", {}, "F2"), "browser", own)).toBeNull();
    // Notebook actions that aren't the tree's are ignored here.
    expect(treeShortcut(press("KeyZ", { ctrl: true }), "browser")).toBeNull();
  });
});
