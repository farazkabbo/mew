import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClipImages } from "./clip-images";

const CLIP = "5a2f1441-1ef4-475a-9b9b-d0eaff0a9bb3";
const picture = () => new Response("x", { headers: { "Content-Type": "image/jpeg" } });
const bitmap = { close: vi.fn() } as unknown as ImageBitmap;

function images(fetchImpl: typeof fetch, onLoad = vi.fn()) {
  return new ClipImages(
    onLoad,
    null,
    () => undefined,
    fetchImpl,
    () => Promise.resolve(bitmap),
  );
}

describe("ClipImages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("asks again after a failure, then redraws with the picture", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockImplementation(() => Promise.resolve(picture()));
    const onLoad = vi.fn();
    const clips = images(fetchImpl, onLoad);

    expect(clips.get(CLIP)).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onLoad).toHaveBeenCalledOnce();
    expect(clips.get(CLIP)).toBe(bitmap);
  });

  it("gives up after three tries and says why", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("", { status: 401 })));
    const clips = images(fetchImpl);

    clips.get(CLIP);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(3);
    expect(clips.get(CLIP)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("stops asking once the page has gone", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response("", { status: 500 })));
    const clips = images(fetchImpl);

    clips.get(CLIP);
    await vi.advanceTimersByTimeAsync(100);
    clips.dispose();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
