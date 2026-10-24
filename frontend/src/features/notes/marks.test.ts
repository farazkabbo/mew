import type { NotesFinding } from "@mew/shared";
import { describe, expect, it } from "vitest";

import type { LocalNoteLine } from "./local-lines";
import { pageMarks } from "./marks";
import { PAGE_ID, recognised } from "./test-helpers";

const A = "11111111-1111-4111-8111-00000000000a";
const B = "11111111-1111-4111-8111-00000000000b";
const OTHER_PAGE_LINE = "11111111-1111-4111-8111-00000000000c";

function line(id: string, y: number): LocalNoteLine {
  return {
    id,
    pageId: PAGE_ID,
    source: "ink",
    strokeIds: [`s-${id}`],
    bbox: [40, y, 300, 24],
    lineIndex: 0,
    contentHash: "0a1b2c3d",
    recognition: recognised("a note"),
    synced: "",
    removed: false,
  };
}

let n = 0;
function finding(type: NotesFinding["type"], extra: Partial<NotesFinding> = {}): NotesFinding {
  n++;
  return {
    id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
    type,
    lineIds: type === "gap" ? [] : [A],
    blockIds: ["b1"],
    screenQuote: "x",
    sourceConflict: false,
    confidence: 0.9,
    evidence: ["model"],
    ...extra,
  };
}

const LINES = [line(A, 100), line(B, 140)];

describe("pageMarks", () => {
  it("marks each kind of finding on the lines it's about", () => {
    const marks = pageMarks(
      [
        finding("difference", { question: "What does the slide say?" }),
        finding("unclear", { lineIds: [B] }),
        finding("gap", { insertAfterLineId: B, question: "Add activation energy?" }),
        finding("match", { lineIds: [A, B] }),
      ],
      LINES,
      {
        source: {
          url: "https://www.youtube.com/watch?v=abc&t=754",
          title: "Enzymes",
          timestampSec: 754,
        },
      },
    );
    expect(marks.map((m) => [m.kind, m.box])).toEqual([
      ["question", [40, 100, 300, 24]],
      ["question", [40, 140, 300, 24]],
      ["gap", [40, 140, 300, 24]],
      ["match", [40, 100, 300, 64]],
    ]);
    expect(marks[3]).toMatchObject({
      link: { href: "https://www.youtube.com/watch?v=abc&t=754", label: "Enzymes · 12:34" },
    });
  });

  it("leaves out findings on other pages, dismissed ones, and gaps with nowhere to go", () => {
    const dismissed = finding("difference");
    const marks = pageMarks(
      [finding("match", { lineIds: [OTHER_PAGE_LINE] }), dismissed, finding("gap")],
      LINES,
      { dismissed: new Set([dismissed.id]) },
    );
    expect(marks).toEqual([]);
  });

  it("never links anywhere but https", () => {
    const [mark] = pageMarks([finding("match")], LINES, { source: { url: "javascript:alert(1)" } });
    expect(mark).toMatchObject({ kind: "match", link: null });
  });

  it("never changes the lines or findings it's given (random cases)", () => {
    const random = seededRandom(7);
    const types = ["match", "difference", "gap", "unclear"] as const;
    for (let round = 0; round < 200; round++) {
      const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, i) =>
        line(`11111111-1111-4111-8111-${String(i).padStart(12, "0")}`, i * 30),
      );
      const findings = Array.from({ length: Math.floor(random() * 6) }, () => {
        const pick = lines[Math.floor(random() * lines.length)]?.id ?? A;
        const type = types[Math.floor(random() * types.length)] ?? "match";
        return finding(type, type === "gap" ? { insertAfterLineId: pick } : { lineIds: [pick] });
      });
      const before = JSON.stringify([lines, findings]);
      const marks = pageMarks(deepFreeze(findings), deepFreeze(lines));
      expect(JSON.stringify([lines, findings])).toBe(before);
      // Every mark sits on one of the page's own lines.
      for (const mark of marks) {
        expect(
          lines.some((l) => mark.box[1] <= l.bbox[1] && l.bbox[1] < mark.box[1] + mark.box[3]),
        ).toBe(true);
      }
    }
  });
});

/** A small seeded generator (mulberry32): the same cases every run. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
