import { DEFAULT_SETTINGS, type UserSettings } from "@mew/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Call = { method: string; body: unknown; reply(settings: UserSettings): void };

/** Holds each request until the test answers it (to control the order replies arrive in). */
function deferredFetch(calls: Call[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit = {}) =>
        new Promise<Response>((resolve) => {
          calls.push({
            method: init.method ?? "GET",
            body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
            reply: (settings) => resolve(Response.json(settings)),
          });
        }),
    ),
  );
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("settings store", () => {
  it("saves quick changes once, and an old reply never undoes a newer change", async () => {
    const calls: Call[] = [];
    deferredFetch(calls);
    const { useSettings } = await import("./store");
    // (Same module instances as the store's, after resetModules.)
    const { useTutor } = await import("../tutor/store");
    const { useMew } = await import("../mew/store");

    // Dragging the slider: one save, with the last value.
    for (const value of [0.75, 0.8, 0.85])
      void useSettings.getState().update({ mew_threshold: value });
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ mew_threshold: 0.85 });

    // While that save is in flight the student turns captions off.
    void useSettings.getState().update({ captions: false });
    calls[0]?.reply({ ...DEFAULT_SETTINGS, mew_threshold: 0.85, captions: true });
    await flush();
    expect(useSettings.getState().settings.captions).toBe(false); // not reverted
    expect(useTutor.getState().captions).toBe(false);
    expect(useMew.getState().threshold).toBe(0.85);

    await vi.advanceTimersByTimeAsync(300);
    expect(calls[1]?.body).toEqual({ captions: false });
    calls[1]?.reply({ ...DEFAULT_SETTINGS, mew_threshold: 0.85, captions: false });
    await flush();
    expect(useSettings.getState()).toMatchObject({
      settings: { captions: false, mew_threshold: 0.85 },
      localOnly: false,
    });
  });

  it("doesn't let a slow first load overwrite a change made meanwhile", async () => {
    const calls: Call[] = [];
    deferredFetch(calls);
    const { useSettings } = await import("./store");

    void useSettings.getState().load();
    void useSettings.getState().update({ answer_style: "direct" });
    calls[0]?.reply({ ...DEFAULT_SETTINGS, onboarded: true });
    await flush();
    expect(useSettings.getState()).toMatchObject({
      loaded: true,
      settings: { answer_style: "direct" },
    });
  });
});
