import { CALIBRATION_PROMPTS, type Point } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { calibrationSamples } from "./calibrate";

const ink: Point[][] = [
  [
    [4, 4, 0.5, 0],
    [20, 30, 0.5, 8],
  ],
];
const prompt = (text: string) => {
  const found = CALIBRATION_PROMPTS.find((p) => p.text === text);
  if (!found) throw new Error(text);
  return found;
};

function reading(texts: (string | null)[]) {
  const bodies: unknown[] = [];
  const fetchImpl = ((_: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    const lines = texts.map((text) =>
      text === null ? null : { text, latex: null, subject: "math", confidence: 0.9 },
    );
    return Promise.resolve(new Response(JSON.stringify({ lines }), { status: 200 }));
  }) as typeof fetch;
  return { fetchImpl, bodies };
}

describe("calibrationSamples", () => {
  it("keeps what neb read wrong as a look-alike, and nothing for what it read right", async () => {
    const { fetchImpl, bodies } = reading(["1", "−"]);
    const samples = await calibrationSamples(
      [
        { prompt: prompt("7"), strokes: ink },
        { prompt: prompt("−"), strokes: ink },
        { prompt: prompt("x"), strokes: [] }, // skipped
      ],
      fetchImpl,
    );
    expect(samples.map((s) => [s.text, s.readAs, s.source])).toEqual([
      ["7", "1", "calibration"],
      ["−", null, "calibration"],
    ]);
    expect(samples[0]?.image.startsWith("iVBORw0KGgo")).toBe(true);
    expect((bodies[0] as { images: string[] }).images).toHaveLength(2);
  });

  it("still keeps the boxes when reading them fails", async () => {
    const failing = (() => Promise.resolve(new Response("", { status: 503 }))) as typeof fetch;
    const samples = await calibrationSamples([{ prompt: prompt("7"), strokes: ink }], failing);
    expect(samples).toHaveLength(1);
    expect(samples[0]?.readAs).toBeNull();
  });
});
