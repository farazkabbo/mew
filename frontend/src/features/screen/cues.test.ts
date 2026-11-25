import { describe, expect, it, vi } from "vitest";

import { CUE_KEYS, CUE_WORDS, type CueDeps, CueVoice, isCueKey } from "./cues";

function deps(over: Partial<CueDeps> = {}): CueDeps & { played: Uint8Array[]; spoken: string[] } {
  const played: Uint8Array[] = [];
  const spoken: string[] = [];
  const stored = new Map<string, Uint8Array>();
  return {
    played,
    spoken,
    voice: () => ({ language: "bn", voiceId: "v1" }),
    synthesize: vi.fn((text: string) => Promise.resolve(new TextEncoder().encode(text))),
    load: (key) => Promise.resolve(stored.get(key) ?? null),
    store: (key, pcm) => {
      stored.set(key, pcm);
      return Promise.resolve();
    },
    play: (pcm) => {
      played.push(pcm);
      return Promise.resolve();
    },
    fallback: (text) => spoken.push(text),
    ...over,
  };
}

describe("cue words", () => {
  it("has every word in every language", () => {
    for (const words of Object.values(CUE_WORDS)) {
      for (const key of CUE_KEYS) expect(words[key].length).toBeGreaterThan(0);
    }
    expect(isCueKey("below")).toBe(true);
    expect(isCueKey("rm -rf")).toBe(false);
  });

  it("plays a prepared clip without making another", async () => {
    const d = deps();
    const voice = new CueVoice(d);
    await voice.prepare();
    expect(d.synthesize).toHaveBeenCalledTimes(CUE_KEYS.length);
    await voice.say("below");
    expect(new TextDecoder().decode(d.played[0])).toBe(CUE_WORDS.bn.below);
    expect(d.synthesize).toHaveBeenCalledTimes(CUE_KEYS.length);
  });

  it("falls back to the browser's voice before the clips exist (offline)", async () => {
    const d = deps({ synthesize: () => Promise.resolve(null) });
    const voice = new CueVoice(d);
    await voice.say("left");
    expect(d.spoken).toEqual([CUE_WORDS.bn.left]);
    expect(d.played).toEqual([]);
  });

  it("loads kept clips instead of making them again", async () => {
    const first = deps();
    await new CueVoice(first).prepare();
    const kept = new Map<string, Uint8Array>();
    await Promise.all(
      CUE_KEYS.map(async (k) => {
        const pcm = await first.synthesize(CUE_WORDS.bn[k], "bn", "v1");
        if (pcm) kept.set(`bn|v1|${k}`, pcm);
      }),
    );
    const second = deps({ load: (key) => Promise.resolve(kept.get(key) ?? null) });
    await new CueVoice(second).prepare();
    expect(second.synthesize).not.toHaveBeenCalled();
  });
});
