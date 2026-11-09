import { asksToDoIt, ScreenStreamEvent } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { jpegBase64 } from "../../test/jpeg";
import type { GenerateStructured, StreamStructuredText } from "./gemini";
import { runScreenTutor } from "./screen-tutor";
import { excerpts, notebookEvent, type StudentNote } from "./student-notes";

vi.mock("server-only", () => ({}));

const NOTE: StudentNote = {
  ref: 1,
  notebook: "Algebra",
  page: 3,
  text: "To solve, undo + first, then ×",
  notebookId: "22222222-2222-4222-8222-222222222222",
  notebookTitle: "Algebra",
  pageId: "33333333-3333-4333-8333-333333333333",
  lineIndex: 4,
  bbox: [40, 300, 500, 60],
};

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY", "test-key");
  vi.spyOn(console, "info").mockImplementation(() => undefined);
});

describe("teaching from the student's own notes", () => {
  it("shows the model the words and where, never the ids", () => {
    expect(excerpts([NOTE])).toEqual([
      { ref: 1, notebook: "Algebra", page: 3, text: "To solve, undo + first, then ×" },
    ]);
  });

  it("opens the notebook at the line only when the student asked neb to do it", () => {
    expect(notebookEvent([NOTE], 1, "can you solve this for me")).toMatchObject({
      type: "notebook",
      pageId: NOTE.pageId,
      lineIndex: 4,
      open: true,
    });
    expect(notebookEvent([NOTE], 1, "why do we subtract 7 first?")?.open).toBe(false);
    // A ref it wasn't given, or none, is nothing.
    expect(notebookEvent([NOTE], 3, "solve it")).toBeNull();
    expect(notebookEvent([NOTE], null, "solve it")).toBeNull();
  });

  it.each(["just give me the answer", "do this for me", "solve it", "finish the rest"])(
    "hears %j as asking neb to do it",
    (question) => expect(asksToDoIt(question)).toBe(true),
  );

  it.each(["what does this button do?", "why is x 4?", "explain step 2"])(
    "hears %j as a question",
    (question) => expect(asksToDoIt(question)).toBe(false),
  );

  it("sends where the note is as its own event, and keeps it out of the reply", async () => {
    const reply = JSON.stringify({
      speech: "You wrote how to do this on page 3 of Algebra: undo the plus first. Try it.",
      actions: [],
      mode: "answer",
      fromNotes: 1,
    });
    const stream: StreamStructuredText = async function* () {
      yield reply;
    };
    const events: ScreenStreamEvent[] = [];
    for await (const event of runScreenTutor(
      {
        transcript: "solve this equation for me",
        app: "msedge.exe",
        scope: "window",
        image: { jpeg: jpegBase64(800, 450), width: 800, height: 450 },
        studentNotes: [NOTE],
      },
      undefined,
      {
        stream,
        generate: vi.fn() as unknown as GenerateStructured,
        now: () => 0,
        newTurnId: () => "11111111-1111-4111-8111-111111111111",
      },
    )) {
      // As sent (parsing would drop an unknown field and hide a leak), and valid.
      expect(ScreenStreamEvent.safeParse(event).success).toBe(true);
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(["speech", "notebook", "response"]);
    expect(events[1]).toMatchObject({ open: true, page: 3 });
    // The desktop app refuses replies with fields it doesn't know.
    const response = events[2];
    expect(response?.type === "response" && "fromNotes" in response.response).toBe(false);
  });
});
