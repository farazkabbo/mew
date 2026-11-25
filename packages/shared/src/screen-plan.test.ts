import { describe, expect, it } from "vitest";

import {
  DoAction,
  planForMode,
  renderPlanInput,
  ScreenPlanModelResponse,
  ScreenPlanRequest,
} from "./screen-plan";

const BASE = {
  mode: "show" as const,
  request: "how do I turn on dark mode?",
  app: "systemsettings.exe",
  controls: [
    { type: "ListItem" as const, name: "Personalization" },
    { type: "Button" as const, name: "Back" },
  ],
};

describe("screen plan schema", () => {
  it("accepts a small request and refuses anything larger or odd", () => {
    expect(ScreenPlanRequest.safeParse(BASE).success).toBe(true);
    const tooMany = { ...BASE, controls: Array.from({ length: 41 }, () => BASE.controls[0]) };
    expect(ScreenPlanRequest.safeParse(tooMany).success).toBe(false);
    const content = { ...BASE, controls: [{ type: "Edit", name: "Dear Sam" }] };
    expect(ScreenPlanRequest.safeParse(content).success).toBe(false);
    const path = { ...BASE, app: "C:\\Windows\\explorer.exe" };
    expect(ScreenPlanRequest.safeParse(path).success).toBe(false);
    const control = { ...BASE, controls: [{ type: "Button", name: "a\u0007b" }] };
    expect(ScreenPlanRequest.safeParse(control).success).toBe(false);
  });

  it("allows only allowlisted DO IT actions", () => {
    expect(DoAction.safeParse({ type: "open_setting", page: "colors" }).success).toBe(true);
    expect(DoAction.safeParse({ type: "open_setting", page: "ms-settings:colors" }).success).toBe(
      false,
    );
    expect(DoAction.safeParse({ type: "delete_file", path: "x" }).success).toBe(false);
    expect(DoAction.safeParse({ type: "send_email" }).success).toBe(false);
    expect(
      DoAction.safeParse({ type: "find_file", query: "lease", kind: "pdf", since: null }).success,
    ).toBe(true);
  });

  it("keeps only what fits the mode", () => {
    const made = ScreenPlanModelResponse.parse({
      speech: "Click Personalization, then Colors.",
      steps: [{ type: "ListItem", name: "Personalization" }],
      action: { type: "open_setting", page: "colors" },
    });
    expect(planForMode("show", made)).toEqual({ steps: made.steps, action: null });
    expect(planForMode("do", made)).toEqual({ steps: [], action: made.action });
    expect(planForMode("do", { ...made, action: null }).action).toEqual({ type: "show_me" });
  });

  it("renders the input without anything but names", () => {
    const input = JSON.parse(renderPlanInput(ScreenPlanRequest.parse(BASE), "2026-11-20")) as {
      controls: unknown[];
      today: string;
    };
    expect(input.controls).toHaveLength(2);
    expect(input.today).toBe("2026-11-20");
  });
});
