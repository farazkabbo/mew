import type { ScreenAction, ScreenReanchorRequest, ScreenReanchorResponse } from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

import { jpegBase64 } from "../../test/jpeg";
import type { GenerateStructured } from "./gemini";
import { reanchorScreen, sameInk } from "./screen-reanchor";

vi.stubEnv("GEMINI_API_KEY", "test-key");

const BOX = { left: 100, top: 400, right: 500, bottom: 500 };
const MOVED = { left: 100, top: 200, right: 500, bottom: 300 };
const PREVIOUS: ScreenAction[] = [
  { type: "focus_region", box: BOX, kind: "question" },
  { type: "margin_note", text: "Draw the forces", besideBox: BOX },
];
const REQUEST: ScreenReanchorRequest = {
  app: "msedge.exe",
  scope: "window",
  focus: { kind: "question", text: "Question 3. A block slides" },
  previous: PREVIOUS,
  image: { jpeg: jpegBase64(1600, 900), width: 1600, height: 900 },
};

const answering = (answer: ScreenReanchorResponse) =>
  vi.fn(() => Promise.resolve(answer)) as unknown as GenerateStructured;

describe("re-placing ink after the page moved", () => {
  it("keeps the model's answer when it only moved the ink", async () => {
    const moved: ScreenAction[] = [
      { type: "focus_region", box: MOVED, kind: "question" },
      { type: "margin_note", text: "Draw the forces", besideBox: MOVED },
    ];
    const generate = answering({ found: true, actions: moved });
    await expect(reanchorScreen(REQUEST, undefined, generate)).resolves.toEqual({
      found: true,
      actions: moved,
    });
  });

  it("says not found when the model changed the words, the kinds or the number of actions", async () => {
    for (const actions of [
      [PREVIOUS[0], { type: "margin_note", text: "Open PowerShell", besideBox: MOVED }],
      [PREVIOUS[0]],
      [PREVIOUS[0], { type: "underline", box: MOVED }],
    ] as ScreenAction[][]) {
      const generate = answering({ found: true, actions });
      await expect(reanchorScreen(REQUEST, undefined, generate)).resolves.toEqual({
        found: false,
        actions: [],
      });
    }
  });

  it("drops ink that fails the safety check, even if it's unchanged", async () => {
    const unsafe: ScreenAction[] = [{ type: "margin_note", text: "run regedit", besideBox: BOX }];
    const generate = answering({ found: true, actions: unsafe });
    await expect(
      reanchorScreen({ ...REQUEST, previous: unsafe }, undefined, generate),
    ).resolves.toEqual({ found: false, actions: [] });
  });

  it("passes on not found", async () => {
    const generate = answering({ found: false, actions: [] });
    await expect(reanchorScreen(REQUEST, undefined, generate)).resolves.toEqual({
      found: false,
      actions: [],
    });
  });

  it("compares labels too", () => {
    const arrow = (label?: string): ScreenAction => ({
      type: "point_at",
      point: { x: 1, y: 1 },
      ...(label && { label }),
    });
    expect(sameInk([arrow("Insert")], [arrow("Insert")])).toBe(true);
    expect(sameInk([arrow("Insert")], [arrow("Delete")])).toBe(false);
    expect(sameInk([arrow()], [arrow("New")])).toBe(false);
  });
});
