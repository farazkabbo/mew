import { CircleAskModelResponse, ScreenTutorModelResponse, TutorResponse } from "@mew/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeAnswer, fakeModel } from "./fake-model";

vi.mock("server-only", () => ({}));
afterEach(() => vi.unstubAllEnvs());

describe("the fake model (preview and staging only)", () => {
  it("is off unless asked, and never on a production deploy", () => {
    expect(fakeModel()).toBe(false);
    vi.stubEnv("NEB_FAKE_MODEL", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(fakeModel()).toBe(true);
    vi.stubEnv("VERCEL_ENV", "production");
    expect(fakeModel()).toBe(false);
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("NEB_DEPLOY_ENV", "production");
    expect(fakeModel()).toBe(false);
  });

  it("answers in the real schemas", () => {
    const parse = (purpose: string) => JSON.parse(fakeAnswer(purpose, "a question")) as unknown;
    expect(ScreenTutorModelResponse.safeParse(parse("screen-ask")).success).toBe(true);
    expect(CircleAskModelResponse.safeParse(parse("circle-ask")).success).toBe(true);
    expect(TutorResponse.safeParse(parse("tutor")).success).toBe(true);
  });

  it("fails on purpose for FAKE_FAIL, and for what it can't answer", () => {
    expect(() => fakeAnswer("screen-ask", [{ text: "FAKE_FAIL please" }])).toThrow("on purpose");
    expect(() => fakeAnswer("coach-plan", "x")).toThrow("no answer");
  });
});
