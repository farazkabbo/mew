import { afterEach, describe, expect, it, vi } from "vitest";

import { isDesktop, remindAboutReviews } from "./bridge";

const ITEM = {
  courseId: "22222222-2222-4222-8222-222222222222",
  courseTitle: "Mechanics",
  conceptId: "33333333-3333-4333-8333-333333333333",
  conceptTitle: "Friction",
  due: "2026-10-21T09:00:00Z",
  isNew: false,
};

const reviews = (items: unknown[]) => () => Promise.resolve(Response.json({ items }));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("desktop bridge", () => {
  it("is inert in a browser", async () => {
    vi.stubGlobal("window", {});
    expect(isDesktop()).toBe(false);
    // No Tauri: nothing to call, so nothing is shown.
    expect(await remindAboutReviews(reviews([ITEM]))).toBe(false);
  });

  it("asks the desktop app to remind about what's due", async () => {
    const invoke = vi.fn(() => Promise.resolve(true));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {}, __TAURI__: { core: { invoke } } });
    expect(isDesktop()).toBe(true);

    expect(await remindAboutReviews(reviews([ITEM, ITEM]))).toBe(true);
    expect(invoke).toHaveBeenCalledWith("notify_due", { count: 2, first: "Friction" });

    invoke.mockClear();
    expect(await remindAboutReviews(reviews([]))).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
