import { ClipView } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { collect, keepEntryVoice, MAX_STEP_BYTES, SpokenLines } from "./entry-voice";

const CLIP = "66666666-6666-4666-8666-000000000001";
const SESSION = "22222222-2222-4222-8222-222222222222";

const view = (turns: { question: string; steps: string[]; summary: string }[]) =>
  ClipView.parse({
    id: CLIP,
    width: 400,
    height: 200,
    pixelRatio: 1,
    source: { app: "msedge.exe", capturedAt: "2026-10-26T09:00:00Z" },
    strokes: [],
    ocrText: "",
    createdAt: "2026-10-26T09:00:00Z",
    entry: {
      sessionId: SESSION,
      studentStrokes: [],
      turns,
      strokeSteps: [],
      conceptHints: [],
    },
  });

const pcm = (n: number) => new Uint8Array(n).fill(1);

describe("a moment's own voice (K8 §4.7)", () => {
  it("uploads the steps it said, once each, and leaves the rest to captions", async () => {
    const lines = new SpokenLines();
    lines.remember("This axis is   velocity.", pcm(4));
    lines.remember("So a flat part means constant speed.", pcm(6));
    lines.remember("Something said in another explanation.", pcm(8));
    const upload = vi.fn<
      (clip: string, turn: number, step: number, pcm: Uint8Array) => Promise<boolean>
    >(() => Promise.resolve(true));
    const uploaded = new Set<string>();
    const one = view([
      {
        question: "Explain this",
        steps: ["This axis is velocity.", "So a flat part means constant speed.", "Not said here."],
        summary: "Flat means constant.",
      },
    ]);
    const deps = { clip: vi.fn(() => Promise.resolve(one)), upload };

    expect(await keepEntryVoice(CLIP, lines, uploaded, deps)).toBe(2);
    expect(upload.mock.calls.map((c) => [c[1], c[2], c[3].byteLength])).toEqual([
      [0, 0, 4],
      [0, 1, 6],
    ]);

    // A follow-up saves the entry again with a turn more: only the new step goes.
    lines.remember("That's the steep part.", pcm(2));
    const two = view([
      ...one.entry!.turns,
      { question: "And this?", steps: ["That's the steep part."], summary: "Steep." },
    ]);
    deps.clip.mockResolvedValueOnce(two);
    expect(await keepEntryVoice(CLIP, lines, uploaded, deps)).toBe(1);
    expect(upload).toHaveBeenLastCalledWith(CLIP, 1, 0, expect.any(Uint8Array));
  });

  it("tries a failed upload again next time", async () => {
    const lines = new SpokenLines();
    lines.remember("A step.", pcm(4));
    const clip = view([{ question: "Q", steps: ["A step."], summary: "S." }]);
    const upload = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const uploaded = new Set<string>();
    const deps = { clip: () => Promise.resolve(clip), upload };
    expect(await keepEntryVoice(CLIP, lines, uploaded, deps)).toBe(0);
    expect(await keepEntryVoice(CLIP, lines, uploaded, deps)).toBe(1);
  });

  it("keeps whole samples, the newest lines, and nothing too long for one step", () => {
    const lines = new SpokenLines();
    lines.remember("odd", pcm(5));
    expect(lines.find("odd")?.byteLength).toBe(4);
    lines.remember("too long", pcm(MAX_STEP_BYTES + 2));
    expect(lines.find("too long")).toBeNull();
    for (let i = 0; i < 45; i++) lines.remember(`line ${i}`, pcm(2));
    expect(lines.find("line 0")).toBeNull();
    expect(lines.find("line 44")).not.toBeNull();
  });

  it("reads a stream whole, or gives up past the limit", async () => {
    const stream = (sizes: number[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const size of sizes) controller.enqueue(pcm(size));
          controller.close();
        },
      });
    expect((await collect(stream([2, 4])))?.byteLength).toBe(6);
    expect(await collect(stream([4, 4]), 6)).toBeNull();
  });
});
