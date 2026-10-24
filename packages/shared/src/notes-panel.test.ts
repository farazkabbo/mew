import { describe, expect, it } from "vitest";

import type { NotesFinding } from "./notes-check";
import { panelGroups } from "./notes-panel";

const LINE = "33333333-3333-4333-8333-333333333333";

let next = 0;

function finding(type: NotesFinding["type"], extra: Partial<NotesFinding> = {}): NotesFinding {
  next++;
  return {
    id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
    type,
    lineIds: type === "gap" ? [] : [LINE],
    blockIds: ["b1"],
    screenQuote: "Enzymes are not consumed",
    sourceConflict: false,
    confidence: 0.9,
    evidence: ["model"],
    ...extra,
  };
}

describe("panelGroups", () => {
  it("lists differences first, then unclears, gaps and one collapsed row of matches", () => {
    const groups = panelGroups([
      finding("match", { noteQuote: "biological catalysts" }),
      finding("gap", { question: "Want to add activation energy?" }),
      finding("difference", { noteQuote: "used up", question: "What does the slide say?" }),
      finding("match"),
      finding("unclear", { noteQuote: "uscd up" }),
    ]);
    expect(groups.map((g) => [g.type, g.heading, g.collapsed])).toEqual([
      ["difference", "One line to look at again", false],
      ["unclear", "One line I couldn't read", false],
      ["gap", "One idea not in your notes yet", false],
      ["match", "2 matches", true],
    ]);
  });

  it("says what was compared, with icons as well as words", () => {
    const [difference] = panelGroups([
      finding("difference", {
        noteQuote: "used up",
        question: "What does the slide say?",
        sourceConflict: true,
      }),
    ]);
    expect(difference?.items[0]).toMatchObject({
      icon: "?",
      title: "What does the slide say?",
      detail:
        "Your notes: “used up” · On screen: “Enzymes are not consumed” · Your course material agrees with your notes: the slide may differ.",
      inNotebook: true,
    });
  });

  it("offers the notebook for a gap only when it knows where it would go", () => {
    const [gaps] = panelGroups([finding("gap"), finding("gap", { insertAfterLineId: LINE })]);
    expect(gaps?.items.map((i) => [i.icon, i.inNotebook])).toEqual([
      ["+", false],
      ["+", true],
    ]);
  });
});
