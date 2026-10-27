import { describe, expect, it } from "vitest";

import { DEVICE_TOKEN_PATTERN, DeviceExchangeRequest } from "./devices";
import { renderScreenInput, SCREEN_TUTOR_PROMPT } from "./prompts/screen";
import {
  AppName,
  type ScreenAction,
  ScreenAskRequest,
  ScreenTutorResponse,
  withFocusRegion,
} from "./screen";

const BOX = { left: 100, top: 100, right: 400, bottom: 200 };

const ASK = {
  transcript: "what does this button do?",
  app: "excel.exe",
  scope: "window",
  image: { jpeg: "/9j/4AAQ", width: 1600, height: 900 },
} as const;

describe("screen schemas", () => {
  it("accepts a reply with every kind of action", () => {
    const parsed = ScreenTutorResponse.parse({
      speech: "This one makes a chart.",
      actions: [
        {
          type: "focus_region",
          box: { left: 50, top: 10, right: 400, bottom: 90 },
          kind: "question",
        },
        { type: "point_at", point: { x: 120, y: 40 }, label: "Insert" },
        { type: "circle_region", box: { left: 100, top: 20, right: 200, bottom: 60 } },
        { type: "underline", box: { left: 0, top: 0, right: 1000, bottom: 10 } },
        { type: "highlight", box: { left: 0, top: 20, right: 300, bottom: 30 } },
        { type: "margin_note", text: "Charts live here", besideBox: BOX, side: "auto" },
        { type: "write_step", latexOrText: "F = ma", besideBox: BOX },
        { type: "clear" },
      ],
      mode: "answer",
      videoTimeSec: 754,
    });
    expect(parsed.actions).toHaveLength(8);
  });

  it("refuses boxes whose edges are out of order, and the old screen_note", () => {
    const reply = (action: unknown) => ({ speech: "Here.", actions: [action], mode: "answer" });
    expect(
      ScreenTutorResponse.safeParse(
        reply({ type: "underline", box: { left: 500, top: 0, right: 100, bottom: 10 } }),
      ).success,
    ).toBe(false);
    expect(
      ScreenTutorResponse.safeParse(reply({ type: "screen_note", text: "x", near: { x: 1, y: 1 } }))
        .success,
    ).toBe(false);
  });

  it("refuses coordinates outside the screenshot and over-long text", () => {
    const point = (x: number) => ({
      speech: "Here.",
      actions: [{ type: "point_at", point: { x, y: 0 } }],
      mode: "answer",
    });
    expect(ScreenTutorResponse.safeParse(point(1001)).success).toBe(false);
    expect(ScreenTutorResponse.safeParse(point(-1)).success).toBe(false);
    expect(ScreenTutorResponse.safeParse(point(10.5)).success).toBe(false);
    expect(
      ScreenTutorResponse.safeParse({ speech: "x".repeat(301), actions: [], mode: "answer" })
        .success,
    ).toBe(false);
  });

  it("only takes executable names for the app, never paths", () => {
    expect(AppName.safeParse("excel.exe").success).toBe(true);
    expect(AppName.safeParse("proton pass.exe").success).toBe(true);
    expect(AppName.safeParse("C:\\Users\\me\\app.exe").success).toBe(false);
    expect(AppName.safeParse("Excel.EXE").success).toBe(false);
    expect(ScreenAskRequest.safeParse({ ...ASK, app: "../x.exe" }).success).toBe(false);
  });

  it("tells the model what it's looking at, without the image itself", () => {
    const text = renderScreenInput(ScreenAskRequest.parse(ASK));
    expect(text).toContain("what does this button do?");
    expect(text).toContain("excel.exe");
    expect(text).toContain("1600×900");
    expect(text).not.toContain("/9j/");
    const silent = renderScreenInput(ScreenAskRequest.parse({ ...ASK, transcript: "  " }));
    expect(silent).toContain("asked you to look at their screen");
    expect(text).not.toContain("videoPlaying");
    const playing = renderScreenInput(ScreenAskRequest.parse({ ...ASK, videoPlaying: true }));
    expect(playing).toContain('"videoPlaying": true');
  });

  it("adds the student's course passages only when there are some (S5)", () => {
    const ask = ScreenAskRequest.parse(ASK);
    expect(renderScreenInput(ask, undefined, [])).not.toContain("courseContext");
    const passage = {
      page: 12,
      heading: "Chain rule",
      text: "d/dx f(g(x))…",
      source: "Calc notes",
    };
    const text = renderScreenInput(ask, undefined, [passage]);
    expect((JSON.parse(text) as { courseContext: unknown }).courseContext).toEqual([passage]);
    expect(SCREEN_TUTOR_PROMPT.system).toContain("courseContext");
    expect(SCREEN_TUTOR_PROMPT.id).toBe("screen-tutor.v5");
  });
});

describe("focus regions", () => {
  const reply = (actions: ScreenAction[]) =>
    ScreenTutorResponse.parse({ speech: "Look.", actions, mode: "answer" });

  it("moves the model's focus region first and keeps only one", () => {
    const focus: ScreenAction = { type: "focus_region", box: BOX, kind: "question" };
    const circle: ScreenAction = { type: "circle_region", box: BOX };
    const second: ScreenAction = { type: "focus_region", box: BOX, kind: "figure" };
    const fixed = withFocusRegion(reply([circle, focus, second]));
    expect(fixed.actions).toEqual([focus, circle]);
  });

  it("derives one from everything drawn when the model forgot", () => {
    const fixed = withFocusRegion(
      reply([
        { type: "circle_region", box: { left: 100, top: 100, right: 200, bottom: 150 } },
        { type: "point_at", point: { x: 600, y: 50 } },
        {
          type: "margin_note",
          text: "Hint",
          besideBox: { left: 120, top: 300, right: 300, bottom: 400 },
        },
      ]),
    );
    expect(fixed.actions[0]).toEqual({
      type: "focus_region",
      box: { left: 100, top: 50, right: 600, bottom: 400 },
      kind: "text",
    });
    expect(fixed.actions).toHaveLength(4);
  });

  it("leaves replies without ink alone, and never exceeds the action cap", () => {
    expect(withFocusRegion(reply([])).actions).toEqual([]);
    expect(withFocusRegion(reply([{ type: "clear" }])).actions).toEqual([{ type: "clear" }]);
    const eight = Array.from({ length: 8 }, () => ({ type: "underline", box: BOX }) as const);
    expect(withFocusRegion(reply(eight)).actions).toHaveLength(8);
  });
});

describe("device schemas", () => {
  it("accepts RFC 7636 verifiers and our token format", () => {
    expect(
      DeviceExchangeRequest.safeParse({
        code: "a".repeat(32),
        verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        deviceName: "DESKTOP-1",
      }).success,
    ).toBe(true);
    expect(DEVICE_TOKEN_PATTERN.test(`mewdt_${"A".repeat(43)}`)).toBe(true);
    expect(DEVICE_TOKEN_PATTERN.test("mewdt_short")).toBe(false);
  });
});
