import { describe, expect, it } from "vitest";

import {
  ariaKeyshortcuts,
  bindingsFor,
  checkBinding,
  defaultBindings,
  formatBinding,
  type KeyPress,
  parseBinding,
  recordKey,
  SHORTCUT_ACTIONS,
  shortcutFor,
  ShortcutBindings,
  suggestBinding,
} from "./shortcuts";

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  key: code.replace(/^Key|^Digit/, "").toLowerCase(),
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

describe("Neb's shortcuts are two keys at most (K2)", () => {
  it("never has a default over two keys, on either platform", () => {
    for (const platform of ["browser", "desktop"] as const) {
      for (const action of SHORTCUT_ACTIONS) {
        for (const binding of defaultBindings(action, platform)) {
          const parsed = parseBinding(binding);
          expect(parsed, `${action}: ${binding}`).not.toBeNull();
          expect(binding.split("+").length).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it("gives every default its own keys (no clashes)", () => {
    for (const platform of ["browser", "desktop"] as const) {
      const all = SHORTCUT_ACTIONS.flatMap((a) => defaultBindings(a, platform));
      expect(new Set(all).size).toBe(all.length);
      for (const action of SHORTCUT_ACTIONS) {
        for (const binding of defaultBindings(action, platform)) {
          expect(checkBinding(binding, action, platform), `${action} ${binding}`).toEqual({
            ok: true,
          });
        }
      }
    }
  });

  it("uses Ctrl+N for a new notebook only in the desktop app, Alt+B everywhere", () => {
    expect(defaultBindings("new_notebook", "browser")).toEqual(["Alt+B"]);
    expect(defaultBindings("new_notebook", "desktop")).toEqual(["Ctrl+N", "Alt+B"]);
    expect(shortcutFor(press("KeyN", { ctrlKey: true }), "browser")).toBeNull();
    expect(shortcutFor(press("KeyN", { ctrlKey: true }), "desktop")).toBe("new_notebook");
    expect(shortcutFor(press("KeyB", { altKey: true }), "browser")).toBe("new_notebook");
    expect(checkBinding("Ctrl+N", "jump", "browser")).toMatchObject({ ok: false });
  });

  it("matches the physical key, so any layout (and Option on a Mac) works", () => {
    // Alt+B on a Mac types "∫"; the code is still KeyB.
    expect(shortcutFor({ ...press("KeyB", { altKey: true }), key: "∫" }, "browser")).toBe(
      "new_notebook",
    );
    // Cmd counts as Ctrl.
    expect(shortcutFor(press("KeyK", { metaKey: true }), "browser")).toBe("jump");
    expect(shortcutFor(press("ArrowUp", { altKey: true }), "browser")).toBe("move_up");
    expect(shortcutFor(press("F2"), "browser")).toBe("rename");
    expect(shortcutFor(press("KeyP"), "browser")).toBe("pen");
    expect(shortcutFor(press("KeyC", { altKey: true }), "browser")).toBe("check_work");
  });

  it("never fires on Ctrl+Alt (AltGr), Shift, or three keys", () => {
    // AltGr+Q types "@" on a German keyboard: Ctrl and Alt both arrive.
    expect(shortcutFor(press("KeyQ", { ctrlKey: true, altKey: true }), "browser")).toBeNull();
    expect(shortcutFor(press("KeyB", { ctrlKey: true, altKey: true }), "browser")).toBeNull();
    expect(shortcutFor(press("KeyP", { shiftKey: true }), "browser")).toBeNull();
    // Ctrl+Shift+Z (redo before K2) is three keys now: nothing.
    expect(shortcutFor(press("KeyZ", { ctrlKey: true, shiftKey: true }), "browser")).toBeNull();
    expect(shortcutFor(press("KeyY", { ctrlKey: true }), "browser")).toBe("redo");
    // Alt+←/→ stay the browser's.
    expect(shortcutFor(press("ArrowLeft", { altKey: true }), "browser")).toBeNull();
    expect(shortcutFor(press("ArrowRight", { altKey: true }), "browser")).toBeNull();
  });

  it("records keys like the settings recorder needs", () => {
    expect(recordKey(press("ControlLeft", { ctrlKey: true }))).toEqual({
      kind: "pending",
      modifier: "Ctrl",
    });
    expect(recordKey(press("KeyJ", { altKey: true }))).toEqual({
      kind: "binding",
      binding: "Alt+J",
    });
    expect(recordKey(press("Digit3"))).toEqual({ kind: "binding", binding: "3" });
    // Ctrl+Shift+Alt+X, Ctrl+Alt+X and Ctrl+Shift+X are refused: two keys max.
    expect(recordKey(press("KeyX", { ctrlKey: true, shiftKey: true, altKey: true }))).toEqual({
      kind: "too_many",
    });
    expect(recordKey(press("KeyX", { ctrlKey: true, altKey: true }))).toEqual({ kind: "too_many" });
    expect(recordKey(press("KeyX", { ctrlKey: true, shiftKey: true }))).toEqual({
      kind: "too_many",
    });
    expect(recordKey(press("AltLeft", { ctrlKey: true, altKey: true }))).toEqual({
      kind: "too_many",
    });
    expect(recordKey(press("KeyX", { shiftKey: true }))).toEqual({ kind: "shift" });
    expect(recordKey(press("NumpadAdd"))).toEqual({ kind: "unsupported" });
  });

  it("refuses bindings over two keys, and keys the browser or Windows keep", () => {
    for (const bad of ["Ctrl+Shift+Alt+X", "Ctrl+Alt+X", "Ctrl+Shift+X", "Shift+X", "Win+X", ""]) {
      expect(parseBinding(bad), bad).toBeNull();
      expect(checkBinding(bad, "jump", "browser")).toMatchObject({
        ok: false,
        reason: "Neb shortcuts are two keys max.",
      });
    }
    for (const reserved of ["Alt+ArrowLeft", "Ctrl+Space", "Ctrl+W", "Ctrl+T", "Alt+F4", "F5"]) {
      expect(checkBinding(reserved, "jump", "desktop"), reserved).toMatchObject({ ok: false });
    }
    expect(checkBinding("Ctrl+Space", "jump", "browser")).toMatchObject({
      reason: "Ctrl+Space is kept for switching input languages (IME).",
    });
    // Moving and typing keys never work alone; the notebook's own single keys stay its own.
    expect(checkBinding("Enter", "jump", "browser")).toMatchObject({ ok: false });
    expect(checkBinding("T", "pen", "browser")).toMatchObject({ ok: false });
  });

  it("finds clashes with other actions and suggests a free key", () => {
    const clash = checkBinding("Alt+N", "new_page", "browser");
    expect(clash).toMatchObject({
      ok: false,
      takenBy: "new_chapter",
      reason: "Alt+N is already “New chapter in this notebook”.",
    });
    const suggestion = clash.ok ? null : clash.suggestion;
    expect(suggestion).toMatch(/^Alt\+[A-Z]$/);
    expect(checkBinding(suggestion as string, "new_page", "browser")).toEqual({ ok: true });
    // After the student rebinds new_chapter, Alt+N is free for new_page.
    expect(checkBinding("Alt+N", "new_page", "browser", { new_chapter: "Alt+J" })).toEqual({
      ok: true,
    });
    // Tools are offered single letters.
    expect(suggestBinding("pen", "browser")).toMatch(/^[A-Z]$/);
  });

  it("lets the student's own binding replace the defaults", () => {
    const own = { new_notebook: "Alt+J" };
    expect(bindingsFor("new_notebook", "desktop", own)).toEqual(["Alt+J"]);
    expect(shortcutFor(press("KeyB", { altKey: true }), "browser", own)).toBeNull();
    expect(shortcutFor(press("KeyJ", { altKey: true }), "browser", own)).toBe("new_notebook");
  });

  it("stores only valid bindings for known actions", () => {
    expect(ShortcutBindings.safeParse({ jump: "Alt+J", pen: "Q" }).success).toBe(true);
    expect(ShortcutBindings.safeParse({ jump: "Ctrl+Shift+J" }).success).toBe(false);
    expect(ShortcutBindings.safeParse({ fly: "Alt+J" }).success).toBe(false);
    expect(ShortcutBindings.safeParse({ jump: 3 }).success).toBe(false);
  });

  it("shows bindings readably", () => {
    expect(formatBinding("Alt+ArrowUp")).toBe("Alt+↑");
    expect(formatBinding("Ctrl+K")).toBe("Ctrl+K");
    expect(ariaKeyshortcuts("Ctrl+K")).toBe("Control+K");
    expect(ariaKeyshortcuts("Alt+B")).toBe("Alt+B");
  });
});
