import { describe, expect, it } from "vitest";

import { HELP_RULE, HelpLevel } from "./help";
import { CIRCLE_ASK_PROMPT } from "./prompts/circle";
import { renderScreenInput, SCREEN_TUTOR_PROMPT } from "./prompts/screen";
import { ScreenAskRequest } from "./screen";
import { renderWatchInput, ScreenWatchReply, ScreenWatchRequest } from "./screen-watch";
import { ScreenWriteModelResponse, TypedText } from "./screen-write";

const IMAGE = { jpeg: "/9j/4AAQ", width: 1600, height: 900 };

describe("help levels", () => {
  it("has the notebook's three levels and Answer", () => {
    expect(HelpLevel.options).toEqual(["quiet", "hint", "coach", "answer"]);
  });

  it("tells both screen prompts how much to give away", () => {
    expect(SCREEN_TUTOR_PROMPT.system).toContain(HELP_RULE);
    expect(CIRCLE_ASK_PROMPT.system).toContain(HELP_RULE);
    expect(SCREEN_TUTOR_PROMPT.system).not.toContain("never the whole answer.\n- Text");
  });

  it("sends the level with a question, hint when the app doesn't say", () => {
    const ask = { transcript: "is this right?", app: null, scope: "window", image: IMAGE };
    const withLevel = ScreenAskRequest.parse({ ...ask, help: "answer" });
    const help = (text: string) => (JSON.parse(text) as { help: unknown }).help;
    expect(help(renderScreenInput(withLevel))).toBe("answer");
    expect(help(renderScreenInput(ScreenAskRequest.parse(ask)))).toBe("hint");
    expect(ScreenAskRequest.safeParse({ ...ask, help: "solve" }).success).toBe(false);
  });
});

describe("watch", () => {
  it("says nothing unless there's a mistake", () => {
    expect(ScreenWatchReply.parse({ status: "fine" })).toEqual({ status: "fine" });
    expect(
      ScreenWatchReply.safeParse({ status: "mistake", speech: "", actions: [], turnId: "x" })
        .success,
    ).toBe(false);
  });

  it("passes on what it already said", () => {
    const request = ScreenWatchRequest.parse({
      app: "onenote.exe",
      scope: "monitor",
      previous: "Check the sign in line 2.",
      image: IMAGE,
    });
    const input = JSON.parse(renderWatchInput(request)) as Record<string, unknown>;
    expect(input).toMatchObject({ help: "hint", previous: "Check the sign in line 2." });
  });
});

describe("typing into a document", () => {
  it("types text and new lines, never other control keys", () => {
    expect(TypedText.safeParse("First line.\n\tSecond line.").success).toBe(true);
    expect(TypedText.safeParse("rm -rf\u001b[A").success).toBe(false);
    expect(TypedText.safeParse("a\u0008b").success).toBe(false);
  });

  it("can decline, with a reason", () => {
    const reply = ScreenWriteModelResponse.parse({
      speech: "That's a terminal, so I won't type there.",
      kind: "insert",
      text: "",
    });
    expect(reply.text).toBe("");
  });
});
