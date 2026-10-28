import { TEXT_SCALE } from "@mew/shared";

/**
 * Appearance and text size (docs/NEB_APP_UI.md §3.1, §3.10): kept on this device, applied to
 * <html> before the first paint (DISPLAY_SCRIPT in the root layout) and whenever they change.
 * - Appearance: "system" follows the OS; "light" or "night" sets `data-theme`.
 * - Text size: 90–130 %, as `--text-scale` (the UI's root font size; never the ink).
 */
export type Appearance = "system" | "light" | "night";

const APPEARANCE_KEY = "neb:appearance";
const SCALE_KEY = "neb:text-scale";
/** Fired on window when either changes (the canvas redraws its ink for night). */
export const DISPLAY_EVENT = "neb:display";

export function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY);
    return value === "light" || value === "night" ? value : "system";
  } catch {
    return "system";
  }
}

export function readTextScale(): number {
  try {
    return clampScale(Number(localStorage.getItem(SCALE_KEY) ?? TEXT_SCALE.default));
  } catch {
    return TEXT_SCALE.default;
  }
}

export function setAppearance(appearance: Appearance): void {
  try {
    if (appearance === "system") localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, appearance);
  } catch {
    // Storage unavailable: it applies until the page reloads.
  }
  applyDisplay(appearance, readTextScale());
}

export function setTextScale(scale: number): void {
  const value = clampScale(scale);
  try {
    if (value === TEXT_SCALE.default) localStorage.removeItem(SCALE_KEY);
    else localStorage.setItem(SCALE_KEY, String(value));
  } catch {
    // As above.
  }
  applyDisplay(readAppearance(), value);
}

export function applyDisplay(appearance: Appearance, scale: number): void {
  const root = document.documentElement;
  if (appearance === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance;
  root.style.setProperty("--text-scale", String(clampScale(scale)));
  window.dispatchEvent(new Event(DISPLAY_EVENT));
}

/** Whether the page shows the night desk now (the student's choice, else the OS's). */
export function isNight(): boolean {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "night") return true;
  if (chosen === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Calls `listener` when night turns on or off (the OS, or the student's choice). */
export function onNightChange(listener: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  window.addEventListener(DISPLAY_EVENT, listener);
  return () => {
    media.removeEventListener("change", listener);
    window.removeEventListener(DISPLAY_EVENT, listener);
  };
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return TEXT_SCALE.default;
  return Math.min(TEXT_SCALE.max, Math.max(TEXT_SCALE.min, Math.round(value * 100) / 100));
}

/** Runs in <head> before the first paint, so a chosen theme never flashes the other one. */
export const DISPLAY_SCRIPT = `(function(){try{var d=document.documentElement,a=localStorage.getItem("${APPEARANCE_KEY}"),s=Number(localStorage.getItem("${SCALE_KEY}"));if(a==="light"||a==="night")d.dataset.theme=a;if(s>=${TEXT_SCALE.min}&&s<=${TEXT_SCALE.max})d.style.setProperty("--text-scale",String(s));}catch(e){}})();`;
