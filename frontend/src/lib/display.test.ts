import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DISPLAY_EVENT,
  DISPLAY_SCRIPT,
  isNight,
  onNightChange,
  readAppearance,
  readTextScale,
  setAppearance,
  setTextScale,
} from "./display";

/** Just enough of a browser: <html>'s dataset and style, localStorage, matchMedia, events. */
function stubBrowser(osDark = false) {
  const store = new Map<string, string>();
  const dataset: Record<string, string> = {};
  const style = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  vi.stubGlobal("document", {
    documentElement: { dataset, style: { setProperty: (k: string, v: string) => style.set(k, v) } },
  });
  const media = { matches: osDark, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal("window", {
    matchMedia: () => media,
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    dispatchEvent: (event: Event) => {
      listeners.get(event.type)?.forEach((fn) => fn());
      return true;
    },
  });
  return { store, dataset, style, media };
}

describe("appearance and text size (§3.1, §3.10)", () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it("follows the OS until the student chooses, and remembers the choice", () => {
    const browser = stubBrowser(true);
    expect(readAppearance()).toBe("system");
    expect(isNight()).toBe(true);
    setAppearance("light");
    expect(browser.dataset.theme).toBe("light");
    expect(isNight()).toBe(false);
    expect(readAppearance()).toBe("light");
    setAppearance("system");
    expect(browser.dataset.theme).toBeUndefined();
    expect(browser.store.size).toBe(0);
  });

  it("keeps text size between 90 and 130 %", () => {
    const browser = stubBrowser();
    setTextScale(2);
    expect(browser.style.get("--text-scale")).toBe("1.3");
    setTextScale(0.5);
    expect(readTextScale()).toBe(0.9);
    browser.store.set("neb:text-scale", "nonsense");
    expect(readTextScale()).toBe(1);
  });

  it("tells listeners (the canvas) when night turns on", () => {
    stubBrowser();
    const changed = vi.fn();
    const stop = onNightChange(changed);
    setAppearance("night");
    expect(changed).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new Event(DISPLAY_EVENT));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("applies a saved choice before the first paint, ignoring bad values", () => {
    const browser = stubBrowser();
    browser.store.set("neb:appearance", "night");
    browser.store.set("neb:text-scale", "1.2");
    new Function(DISPLAY_SCRIPT)();
    expect(browser.dataset.theme).toBe("night");
    expect(browser.style.get("--text-scale")).toBe("1.2");

    const other = stubBrowser();
    other.store.set("neb:appearance", "purple");
    other.store.set("neb:text-scale", "9");
    new Function(DISPLAY_SCRIPT)();
    expect(other.dataset.theme).toBeUndefined();
    expect(other.style.size).toBe(0);
  });
});
