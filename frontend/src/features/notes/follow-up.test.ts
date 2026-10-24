import type { NotesCheckResult, NotesFinding, StoredFinding } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { progressOf, useNotesCheck } from "./check-store";
import type { NotebookDb } from "../notebook/db";
import {
  addGapHeading,
  answerFinding,
  dismissFinding,
  fromStored,
  lineAfter,
  lineEdits,
} from "./follow-up";
import type { LocalNoteLine } from "./local-lines";

const PAGE = "11111111-1111-4111-8111-111111111111";
const LINE_A = "22222222-2222-4222-8222-222222222222";
const LINE_B = "33333333-3333-4333-8333-333333333333";
const FINDING = "44444444-4444-4444-8444-444444444444";

const DIFFERENCE: NotesFinding = {
  id: FINDING,
  type: "difference",
  lineIds: [LINE_A],
  blockIds: ["b1"],
  noteQuote: "used up",
  screenQuote: "not consumed",
  question: "What does the slide say happens to enzymes?",
  sourceConflict: false,
  confidence: 0.9,
  evidence: [],
};

function line(id: string, lineIndex: number, text: string | null): LocalNoteLine {
  return {
    id,
    pageId: PAGE,
    source: "ink",
    strokeIds: [],
    bbox: [0, lineIndex * 40, 200, 24],
    lineIndex,
    contentHash: "0a1b2c3d",
    recognition: text === null ? null : { text, latex: null, subject: "biology", confidence: 0.9 },
    synced: "",
    removed: false,
  };
}

function stored(checkId: string | null = "55555555-5555-4555-8555-555555555555") {
  const result: NotesCheckResult = {
    checkId,
    related: true,
    topic: "Enzymes",
    speech: "One line to look at.",
    scopeLabel: "",
    pages: [],
    findings: [DIFFERENCE],
    latencyMs: 10,
  };
  useNotesCheck.setState({ result, progress: {}, restored: {}, dismissed: new Set() });
}

/** A fetch answering each follow-up with the next reply in `replies`. */
function server(...replies: { status?: number; body?: unknown }[]) {
  return vi.fn(async () => {
    const next = replies.shift() ?? { status: 500 };
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status ?? 200,
    });
  });
}

const stillDifferent = {
  body: { outcome: "still_different", reply: "Look again.", status: "open" },
};

beforeEach(() => stored());

describe("answering a finding", () => {
  it("shows the tutor's reply and settles the mark when the answer is right", async () => {
    const fetch = server({
      body: { outcome: "fixed", reply: "That's it.", status: "resolved_fixed" },
    });
    await answerFinding(FINDING, "they aren't used up", fetch);

    expect(fetch).toHaveBeenCalledWith(
      `/api/notes/findings/${FINDING}/resolve`,
      expect.objectContaining({ body: JSON.stringify({ reply: "they aren't used up" }) }),
    );
    expect(progressOf(useNotesCheck.getState(), FINDING)).toMatchObject({
      status: "resolved_fixed",
      reply: "That's it.",
      busy: false,
    });
  });

  it("explains after two answers that still differ, instead of asking a third time", async () => {
    const explained = {
      body: { explanation: "The slide says they're not consumed.", status: "explained" },
    };
    const fetch = server(stillDifferent, stillDifferent, explained);

    await answerFinding(FINDING, "used up", fetch);
    expect(progressOf(useNotesCheck.getState(), FINDING)).toMatchObject({
      status: "open",
      misses: 1,
    });
    await answerFinding(FINDING, "still used up", fetch);

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch).toHaveBeenLastCalledWith(
      `/api/notes/findings/${FINDING}/explain`,
      expect.anything(),
    );
    expect(progressOf(useNotesCheck.getState(), FINDING)).toMatchObject({
      status: "explained",
      reply: "The slide says they're not consumed.",
    });
  });

  it("says when it's been asked too often, without losing the finding", async () => {
    await answerFinding(FINDING, "x", server({ status: 429 }));
    expect(progressOf(useNotesCheck.getState(), FINDING)).toMatchObject({
      status: "open",
      busy: false,
      reply: "That's a lot of checking for now. Try again in a little while.",
    });
  });

  it("lets go of a finding settled elsewhere", async () => {
    await answerFinding(FINDING, "x", server({ status: 409 }));
    expect(useNotesCheck.getState().dismissed.has(FINDING)).toBe(true);
  });

  it("never asks about a check that wasn't stored", async () => {
    stored(null);
    const fetch = server();
    await answerFinding(FINDING, "x", fetch);
    await dismissFinding(FINDING, fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(useNotesCheck.getState().dismissed.has(FINDING)).toBe(true); // still hidden here
  });
});

describe("a gap's heading", () => {
  it("is written as tutor ink under the line the gap follows", async () => {
    const gap: NotesFinding = {
      ...DIFFERENCE,
      type: "gap",
      lineIds: [],
      insertAfterLineId: LINE_A,
    };
    useNotesCheck.setState((s) => ({ result: s.result && { ...s.result, findings: [gap] } }));
    const anchor = { ...line(LINE_A, 0, "enzymes are catalysts"), strokeIds: ["s1", "s2"] };
    const db = { noteLines: { get: async () => anchor } } as unknown as NotebookDb;
    const ink = { render: vi.fn(async () => undefined) };

    await addGapHeading(FINDING, db, ink, server({ body: { heading: "Activation energy — ?" } }));

    expect(ink.render).toHaveBeenCalledWith(
      [
        {
          type: "write_text",
          text: "Activation energy — ?",
          anchor: { near: "below_active_line" },
        },
      ],
      { nearStrokes: ["s1", "s2"] },
    );
    expect(progressOf(useNotesCheck.getState(), FINDING)).toMatchObject({ headingWritten: true });
  });
});

describe("pure helpers", () => {
  it("re-checks a line only when its recognised text changes", () => {
    const first = lineEdits([DIFFERENCE], [line(LINE_A, 0, "enzymes used up")], {});
    expect(first).toEqual([{ findingId: FINDING, text: "enzymes used up", changed: false }]);

    const seen = {
      [FINDING]: { status: "open" as const, busy: false, misses: 0, lineText: "enzymes used up" },
    };
    expect(lineEdits([DIFFERENCE], [line(LINE_A, 0, "enzymes used up")], seen)).toEqual([]);
    expect(lineEdits([DIFFERENCE], [line(LINE_A, 0, null)], seen)).toEqual([]); // not recognised yet
    expect(lineEdits([DIFFERENCE], [line(LINE_A, 0, "enzymes not used up")], seen)).toEqual([
      { findingId: FINDING, text: "enzymes not used up", changed: true },
    ]);
    const settled = { [FINDING]: { ...seen[FINDING], status: "resolved_fixed" as const } };
    expect(lineEdits([DIFFERENCE], [line(LINE_A, 0, "other")], settled)).toEqual([]);
  });

  it("finds the line written under a gap's heading", () => {
    const anchor = line(LINE_A, 0, "enzymes are catalysts");
    expect(lineAfter([anchor, line(LINE_B, 1, "activation energy: min to start")], anchor)).toBe(
      "activation energy: min to start",
    );
    expect(lineAfter([anchor], anchor)).toBeNull();
  });

  it("restores open differences, not gaps (their place isn't stored)", () => {
    const row: StoredFinding = {
      id: FINDING,
      checkId: "55555555-5555-4555-8555-555555555555",
      type: "difference",
      noteLineIds: [LINE_A],
      pageId: PAGE,
      noteQuote: "used up",
      screenSnippet: "not consumed",
      question: "What does the slide say?",
      explanation: "",
      conceptHint: null,
      conceptId: null,
      confidence: 0.8,
      sourceConflict: false,
      status: "open",
      courseId: null,
    };
    expect(fromStored(row)).toEqual([
      expect.objectContaining({
        id: FINDING,
        lineIds: [LINE_A],
        question: "What does the slide say?",
      }),
    ]);
    expect(fromStored({ ...row, type: "gap" })).toEqual([]);
    expect(fromStored({ ...row, status: "dismissed" })).toEqual([]);
  });
});
