import { describe, expect, it, vi } from "vitest";

import { ScreenAnswerDetail } from "./events";
import { ScreenCoachVoice } from "./screen-coach";

const ANSWER = ScreenAnswerDetail.parse({
  turnId: "33333333-3333-4333-8333-333333333333",
  response: { speech: "That inserts a chart.", actions: [], mode: "answer" },
});

function coach(transcript = "what does this do?") {
  const deps = {
    listener: {
      start: vi.fn(),
      finish: vi.fn(() => Promise.resolve(transcript)),
      cancel: vi.fn(),
    },
    ask: vi.fn(() => Promise.resolve()),
    speak: vi.fn(() => Promise.resolve()),
    hush: vi.fn(),
    spoken: vi.fn(),
  };
  return { voice: new ScreenCoachVoice(deps), deps };
}

describe("ScreenCoachVoice", () => {
  it("listens while the key is held and asks with the words when it's released", async () => {
    const { voice, deps } = coach();
    voice.onListen();
    expect(deps.listener.start).toHaveBeenCalledOnce();
    await voice.onRelease();
    expect(deps.ask).toHaveBeenCalledWith("what does this do?");
  });

  it("speaks the early speech once, not again with the full answer", () => {
    const { voice, deps } = coach();
    voice.onListen();
    voice.onSpeech("That inserts a chart.");
    voice.onAnswer(ANSWER);
    expect(deps.speak).toHaveBeenCalledTimes(1);
  });

  it("speaks the full answer when no early speech came (and is ready for the next turn)", () => {
    const { voice, deps } = coach();
    voice.onAnswer(ANSWER);
    voice.onAnswer(ANSWER);
    expect(deps.speak).toHaveBeenCalledTimes(2);
    expect(deps.speak).toHaveBeenCalledWith("That inserts a chart.");
  });

  it("stops talking when the hotkey goes down", () => {
    const { voice, deps } = coach();
    voice.onListen();
    expect(deps.hush).toHaveBeenCalledOnce();
  });

  it("always says coach mode's lines, cutting off anything older", () => {
    const { voice, deps } = coach();
    voice.onListen();
    voice.onSpeech("An answer.");
    voice.onSay("Nice. Click PivotTable.");
    voice.onSay("Look where I'm pointing.");
    expect(deps.speak.mock.calls).toEqual([
      ["An answer."],
      ["Nice. Click PivotTable."],
      ["Look where I'm pointing."],
    ]);
    expect(deps.hush).toHaveBeenCalledTimes(3); // the hotkey, then each line
  });

  it("stops listening without asking when the capture was refused", () => {
    const { voice, deps } = coach();
    voice.onListen();
    voice.onCancel();
    expect(deps.listener.cancel).toHaveBeenCalledOnce();
    expect(deps.ask).not.toHaveBeenCalled();
  });
});
