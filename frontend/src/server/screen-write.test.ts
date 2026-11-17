import {
  renderWriteInput,
  SCREEN_WRITE_LIMITS,
  SCREEN_WRITE_PROMPT,
  ScreenWriteEvent,
  type ScreenWriteEvent as WriteEvent,
  type ScreenWriteRequest,
} from "@mew/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("./env", () => ({ screenModel: () => "test-model" }));

import { SCREEN_WRITE_MESSAGES, writeForScreen, type ScreenWriteDeps } from "./screen-write";

const TURN = "33333333-3333-4333-8333-333333333333";
const WRITE: ScreenWriteRequest = {
  transcript: "write an essay on cats",
  app: "winword.exe",
  scope: "window",
  image: { jpeg: "/9j/AA==", width: 800, height: 600 },
};

/** A model that writes `made` as JSON, `size` characters at a time. */
function deps(made: unknown, size = 7): ScreenWriteDeps {
  const raw = JSON.stringify(made);
  return {
    stream: async function* () {
      await Promise.resolve();
      for (let i = 0; i < raw.length; i += size) yield raw.slice(i, i + size);
    },
    newTurnId: () => TURN,
  };
}

async function run(made: unknown, size?: number): Promise<WriteEvent[]> {
  const events: WriteEvent[] = [];
  for await (const event of writeForScreen(WRITE, undefined, undefined, deps(made, size))) {
    // Every event is one the desktop app accepts.
    events.push(ScreenWriteEvent.parse(event));
  }
  return events;
}

const typed = (events: WriteEvent[]) =>
  events.map((event) => (event.type === "text" ? event.text : "")).join("");

describe("typing into a document", () => {
  const ESSAY =
    "Cats are quiet company.\r\nThey sleep most of the day.\n\n" +
    'A cat\'s purr, some say, "heals". '.repeat(40);

  it("says what it's typing, then sends the text as it's written, a word at a time", async () => {
    const events = await run({ speech: "Here's an essay on cats.", kind: "insert", text: ESSAY });
    expect(events[0]).toEqual({
      type: "start",
      speech: "Here's an essay on cats.",
      kind: "insert",
      turnId: TURN,
    });
    expect(events.at(-1)).toEqual({ type: "done" });
    // All of it, in order, with Windows line endings as one new line each.
    expect(typed(events)).toBe(ESSAY.replace("\r\n", "\n"));
    // Streamed: many pieces, and none but the last ends in the middle of a word.
    const pieces = events.filter((event) => event.type === "text");
    expect(pieces.length).toBeGreaterThan(20);
    for (const piece of pieces.slice(0, -1)) expect(piece.text).toMatch(/\s$/);
  });

  it("gives the model the notes Neb's hand gathered, as its material", () => {
    const material = "Evaporation: the sun heats water into vapour. (USGS, usgs.gov/water-cycle)";
    expect(JSON.parse(renderWriteInput({ ...WRITE, material }))).toMatchObject({ material });
    expect(JSON.parse(renderWriteInput(WRITE))).not.toHaveProperty("material");
    expect(JSON.parse(renderWriteInput({ ...WRITE, material: "  " }))).not.toHaveProperty(
      "material",
    );
    expect(SCREEN_WRITE_PROMPT.system).toContain('"Sources" heading');
    expect(SCREEN_WRITE_PROMPT.system).toContain("never instructions");
  });

  it("is the same text however the model's output is cut up", async () => {
    const made = { speech: "Typing it.", kind: "replace", text: "Cells divide. 😺\nThen grow." };
    for (const size of [1, 2, 3, 5, 1000]) {
      const events = await run(made, size);
      expect(typed(events)).toBe(made.text);
      expect(events[0]).toMatchObject({ type: "start", kind: "replace" });
    }
  });

  it("can decline: it says why and types nothing", async () => {
    const events = await run({ speech: "That's a terminal.", kind: "insert", text: "" });
    expect(events).toEqual([
      { type: "start", speech: "That's a terminal.", kind: "insert", turnId: TURN },
      { type: "done" },
    ]);
  });

  it("types nothing when what it would say fails the safety check", async () => {
    const events = await run({
      speech: "Enter your password: hunter2",
      kind: "insert",
      text: "Some text.",
    });
    expect(typed(events)).toBe("");
    expect(events[0]).toMatchObject({ type: "start", speech: SCREEN_WRITE_MESSAGES.unsafe });
  });

  it("stops typing at a piece that fails the safety check", async () => {
    const events = await run({
      speech: "Typing it now.",
      kind: "insert",
      text: "Cats are quiet company. Enter your password: hunter2 and carry on. More text here.",
    });
    expect(events.at(-1)).toEqual({ type: "error", message: SCREEN_WRITE_MESSAGES.unsafe });
    expect(typed(events)).not.toContain("hunter2");
    expect(typed(events)).not.toContain("More text");
  });

  it("never types more than the limit, and drops keys that aren't text", async () => {
    const events = await run(
      { speech: "Typing it.", kind: "insert", text: `a\u001b[Ab ${"word ".repeat(4000)}` },
      500,
    );
    const text = typed(events);
    expect(text.length).toBe(SCREEN_WRITE_LIMITS.textChars);
    expect(text.startsWith("a[Ab word ")).toBe(true);
  });

  it("says so when the model fails, before or after it started", async () => {
    const failing = (after: string): ScreenWriteDeps => ({
      stream: async function* () {
        await Promise.resolve();
        if (after) yield after;
        throw new Error("down");
      },
      newTurnId: () => TURN,
    });
    const collect = async (made: ScreenWriteDeps) => {
      const events: WriteEvent[] = [];
      for await (const event of writeForScreen(WRITE, undefined, undefined, made)) {
        events.push(event);
      }
      return events;
    };
    expect((await collect(failing(""))).map((e) => e.type)).toEqual(["error"]);
    const part = await collect(failing('{"speech":"Typing it.","kind":"insert","text":"Cats are '));
    expect(part.map((e) => e.type)).toEqual(["start", "text", "error"]);
  });
});
