import { z } from "zod";

/**
 * The notebook app's keyboard shortcuts (K2, docs/NOTEBOOKS_K.md §11.3 and §11.4): what each
 * action is bound to by default on each platform, the student's own bindings, and the rules a
 * binding must follow. **Two keys at most**: one modifier (Ctrl or Alt) and a key, or a single
 * key (only inside Neb, never while typing in a field). Ctrl+Alt never counts: it's AltGr on
 * many keyboards. Pure, so the settings recorder, the key handlers and the tests share it.
 */

export const SHORTCUT_ACTIONS = [
  "new_notebook",
  "new_chapter",
  "new_page",
  "rename",
  "jump",
  "import_pdf",
  "check_work",
  "move_up",
  "move_down",
  "undo",
  "redo",
  "pen",
  "eraser",
  "highlighter",
  "lasso",
] as const;
export type ShortcutAction = (typeof SHORTCUT_ACTIONS)[number];

/** Where the notebook runs: a browser tab, or the desktop app's window (which can take Ctrl+N). */
export type ShortcutPlatform = "browser" | "desktop";

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  new_notebook: "New notebook",
  new_chapter: "New chapter in this notebook",
  new_page: "New page here",
  rename: "Rename the selected notebook, chapter or page",
  jump: "Jump to any notebook, chapter or page",
  import_pdf: "Import a PDF",
  check_work: "Check my work",
  move_up: "Move the selected chapter up",
  move_down: "Move the selected chapter down",
  undo: "Undo",
  redo: "Redo",
  pen: "Pen",
  eraser: "Eraser",
  highlighter: "Highlighter",
  lasso: "Lasso",
};

/** Keys a binding may end with (KeyboardEvent.code, without "Key" and "Digit"). */
const KEY_NAMES = [
  ...Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Enter",
  "Space",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Comma",
  "Period",
  "Slash",
  "Semicolon",
  "Quote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Backquote",
] as const;
const KEYS = new Set<string>(KEY_NAMES);

/** A binding as stored: "Alt+B", "Ctrl+K", "F2", "P", "Alt+ArrowUp". */
export const ShortcutBinding = z
  .string()
  .max(20)
  .refine((text) => parseBinding(text) !== null, "Not a shortcut of at most two keys.");

/** The student's own bindings: only the actions they changed (the rest keep their defaults). */
export const ShortcutBindings = z.partialRecord(z.enum(SHORTCUT_ACTIONS), ShortcutBinding);
export type ShortcutBindings = z.infer<typeof ShortcutBindings>;

type Modifier = "Ctrl" | "Alt";
type Parsed = { modifier: Modifier | null; key: string };

/** The binding's parts, or null if it isn't one (a third key, Shift, Win, an unknown key). */
export function parseBinding(text: string): Parsed | null {
  const parts = text.split("+");
  if (parts.length > 2) return null;
  const key = parts.at(-1) ?? "";
  if (!KEYS.has(key)) return null;
  if (parts.length === 1) return { modifier: null, key };
  const modifier = parts[0];
  return modifier === "Ctrl" || modifier === "Alt" ? { modifier, key } : null;
}

const DEFAULTS: Record<ShortcutAction, { browser: string[]; desktop?: string[] }> = {
  // Browsers keep Ctrl+N for a new window: Alt+B everywhere, Ctrl+N in the desktop app too.
  new_notebook: { browser: ["Alt+B"], desktop: ["Ctrl+N", "Alt+B"] },
  new_chapter: { browser: ["Alt+N"] },
  new_page: { browser: ["Alt+P"] },
  rename: { browser: ["F2"] },
  jump: { browser: ["Ctrl+K"] },
  import_pdf: { browser: ["Ctrl+O"] },
  check_work: { browser: ["Alt+C"] },
  move_up: { browser: ["Alt+ArrowUp"] },
  move_down: { browser: ["Alt+ArrowDown"] },
  undo: { browser: ["Ctrl+Z"] },
  // Ctrl+Shift+Z is three keys: K2 dropped it.
  redo: { browser: ["Ctrl+Y"] },
  pen: { browser: ["P"] },
  eraser: { browser: ["E"] },
  highlighter: { browser: ["H"] },
  lasso: { browser: ["L"] },
};

/** Single keys the notebook keeps for itself (not rebindable), so no action may take them. */
export const FIXED_KEYS: Record<string, string> = {
  T: "Show or hide the tutor's ink",
  Equal: "Zoom in",
  Minus: "Zoom out",
  "0": "Reset the zoom",
};

/** What `action` is bound to on `platform`, with the student's own binding replacing defaults. */
export function bindingsFor(
  action: ShortcutAction,
  platform: ShortcutPlatform,
  own: ShortcutBindings = {},
): string[] {
  const mine = own[action];
  if (mine) return [mine];
  const defaults = DEFAULTS[action];
  return (platform === "desktop" && defaults.desktop) || defaults.browser;
}

export function defaultBindings(action: ShortcutAction, platform: ShortcutPlatform): string[] {
  return bindingsFor(action, platform);
}

/** The keys of one key press, as far as shortcuts care (a KeyboardEvent has them all). */
export type KeyPress = {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

export type Recorded =
  | { kind: "binding"; binding: string }
  /** Only modifiers so far: keep listening. */
  | { kind: "pending"; modifier: Modifier | null }
  | { kind: "too_many" }
  /** Shift with a key: it types a capital, so Neb doesn't use it. */
  | { kind: "shift" }
  | { kind: "unsupported" };

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "ShiftLeft",
  "ShiftRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

/** The key name for a KeyboardEvent.code ("KeyB" → "B", "Digit2" → "2"), or null. */
function keyName(code: string): string | null {
  const name = code.replace(/^Key(?=[A-Z]$)/, "").replace(/^Digit(?=[0-9]$)/, "");
  return KEYS.has(name) ? name : null;
}

/**
 * What a key press records, for the settings recorder and for matching. Cmd (on a Mac) counts as
 * Ctrl. More than two keys, Shift, or Ctrl with Alt is `too_many`: "two keys max".
 */
export function recordKey(event: KeyPress): Recorded {
  const ctrl = event.ctrlKey || event.metaKey;
  const modifiers = [ctrl, event.altKey, event.shiftKey].filter(Boolean).length;
  const isModifier = MODIFIER_CODES.has(event.code);
  if (modifiers >= 2) return { kind: "too_many" };
  if (isModifier) {
    return { kind: "pending", modifier: ctrl ? "Ctrl" : event.altKey ? "Alt" : null };
  }
  if (event.shiftKey) return { kind: "shift" };
  const key = keyName(event.code);
  if (!key) return { kind: "unsupported" };
  const modifier = ctrl ? "Ctrl" : event.altKey ? "Alt" : null;
  return { kind: "binding", binding: modifier ? `${modifier}+${key}` : key };
}

/** The binding a key press is, if it could be one. */
export function bindingOfKey(event: KeyPress): string | null {
  const recorded = recordKey(event);
  return recorded.kind === "binding" ? recorded.binding : null;
}

/** The action a key press means (null for none), with the student's bindings. */
export function shortcutFor(
  event: KeyPress,
  platform: ShortcutPlatform,
  own: ShortcutBindings = {},
): ShortcutAction | null {
  const binding = bindingOfKey(event);
  if (!binding) return null;
  return (
    SHORTCUT_ACTIONS.find((action) => bindingsFor(action, platform, own).includes(binding)) ?? null
  );
}

/** Keys the browser or Windows keep (a page can't take them, or must never). */
const RESERVED: Record<string, string> = {
  "Alt+ArrowLeft": "your browser's Back",
  "Alt+ArrowRight": "your browser's Forward",
  "Alt+F4": "closing the window",
  "Alt+Space": "the window menu",
  "Alt+Tab": "switching apps",
  "Alt+Escape": "switching apps",
  "Ctrl+Escape": "the Start menu",
  "Ctrl+Space": "switching input languages (IME)",
  "Ctrl+Tab": "switching tabs",
  "Ctrl+T": "a new tab",
  "Ctrl+W": "closing the tab",
  "Ctrl+Q": "quitting the browser",
  "Ctrl+PageUp": "switching tabs",
  "Ctrl+PageDown": "switching tabs",
  "Ctrl+R": "reloading the page",
  F5: "reloading the page",
  F11: "full screen",
  F12: "developer tools",
  "Ctrl+F": "finding on the page",
  "Ctrl+P": "printing",
  "Ctrl+C": "copying",
  "Ctrl+V": "pasting",
  "Ctrl+X": "cutting",
  "Ctrl+A": "selecting everything",
  "Ctrl+Equal": "zooming the page",
  "Ctrl+Minus": "zooming the page",
  "Ctrl+0": "zooming the page",
};
/** Browsers keep these for themselves; the desktop app's window can take them. */
const BROWSER_ONLY: Record<string, string> = {
  "Ctrl+N": "a new browser window",
  "Alt+D": "your browser's address bar",
  "Alt+E": "your browser's menu",
  "Alt+F": "your browser's menu",
  "Alt+Home": "your browser's home page",
};
/** Single keys that move around or type in Neb: never a shortcut on their own. */
const NOT_ALONE = new Set([
  "Enter",
  "Space",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export type BindingCheck =
  { ok: true } | { ok: false; reason: string; suggestion: string | null; takenBy?: ShortcutAction };

/** Whether `binding` may be given to `action` (with the student's other bindings). */
export function checkBinding(
  binding: string,
  action: ShortcutAction,
  platform: ShortcutPlatform,
  own: ShortcutBindings = {},
): BindingCheck {
  const fail = (reason: string, takenBy?: ShortcutAction): BindingCheck => ({
    ok: false,
    reason,
    suggestion: suggestBinding(action, platform, own),
    ...(takenBy && { takenBy }),
  });
  const parsed = parseBinding(binding);
  if (!parsed) return fail("Neb shortcuts are two keys max.");
  const reserved =
    RESERVED[binding] ?? (platform === "browser" ? BROWSER_ONLY[binding] : undefined);
  if (reserved) return fail(`${formatBinding(binding)} is kept for ${reserved}.`);
  if (!parsed.modifier && NOT_ALONE.has(parsed.key)) {
    return fail(`${formatBinding(binding)} on its own is for moving around and typing.`);
  }
  if (!parsed.modifier && FIXED_KEYS[parsed.key]) {
    return fail(`${formatBinding(binding)} already means “${FIXED_KEYS[parsed.key]}”.`);
  }
  const takenBy = SHORTCUT_ACTIONS.find(
    (other) => other !== action && bindingsFor(other, platform, own).includes(binding),
  );
  if (takenBy) {
    return fail(`${formatBinding(binding)} is already “${SHORTCUT_LABELS[takenBy]}”.`, takenBy);
  }
  return { ok: true };
}

/** A free binding for `action` (Alt with a letter; a letter for the tools), or null. */
export function suggestBinding(
  action: ShortcutAction,
  platform: ShortcutPlatform,
  own: ShortcutBindings = {},
): string | null {
  const tool = ["pen", "eraser", "highlighter", "lasso"].includes(action);
  const used = new Set(
    SHORTCUT_ACTIONS.filter((a) => a !== action).flatMap((a) => bindingsFor(a, platform, own)),
  );
  const letters = Array.from("ABCDEFGHIJKLMNOPQRSUVWXYZ");
  const candidates = tool ? letters : letters.map((l) => `Alt+${l}`);
  return (
    candidates.find((c) => !used.has(c) && !RESERVED[c] && !BROWSER_ONLY[c] && !FIXED_KEYS[c]) ??
    null
  );
}

const SHOWN: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Equal: "=",
  Minus: "-",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
  Escape: "Esc",
};

/** How a binding is shown: "Alt+↑", "Ctrl+K", "F2". */
export function formatBinding(binding: string): string {
  const parsed = parseBinding(binding);
  if (!parsed) return binding;
  const key = SHOWN[parsed.key] ?? parsed.key;
  return parsed.modifier ? `${parsed.modifier}+${key}` : key;
}

/**
 * "What can I say?" (NEB_APP_UI §5.6): the shortcuts sheet, with the phrases to say instead.
 * Decided here, before the classifier, as a fixed question about neb itself.
 */
export function asksWhatToSay(utterance: string): boolean {
  const text = utterance
    .toLowerCase()
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:hey |ok |okay )?(?:neb|mew)\b ?/, "");
  return /^(?:so )?(?:what (?:can|do) i say|what can (?:i|you) do|what are (?:the|your) (?:shortcuts|commands)|show (?:me )?(?:the )?(?:shortcuts|commands|keys))(?: here| to you| now)?$/.test(
    text,
  );
}

/** The ARIA `aria-keyshortcuts` value for a binding ("Alt+B", "Control+K"). */
export function ariaKeyshortcuts(binding: string): string {
  const parsed = parseBinding(binding);
  if (!parsed) return "";
  const key = parsed.key === "Space" ? "Space" : parsed.key;
  return parsed.modifier === "Ctrl" ? `Control+${key}` : parsed.modifier ? `Alt+${key}` : key;
}
