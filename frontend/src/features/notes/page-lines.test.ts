import { translateStroke } from "@mew/ink";
import { describe, expect, it } from "vitest";

import type { LocalNoteLine } from "./local-lines";
import { planPageLines } from "./page-lines";
import { clipImage, ids, inkOf, PAGE_ID, penStroke, recognised, writtenLine } from "./test-helpers";

const nothingKnown = () => undefined;

function plan(
  strokes: Parameters<typeof inkOf>[0],
  stored: LocalNoteLine[] = [],
  extra: Partial<Parameters<typeof planPageLines>[0]> = {},
) {
  return planPageLines({
    pageId: PAGE_ID,
    ink: inkOf(strokes),
    images: [],
    stored,
    known: nothingKnown,
    newId: ids(),
    ...extra,
  });
}

/** The plan's records with recognitions filled in, as if they'd been read and saved. */
function readAll(lines: LocalNoteLine[], text = "a note"): LocalNoteLine[] {
  return lines.map((l) => ({ ...l, recognition: l.recognition ?? recognised(text) }));
}

describe("planPageLines", () => {
  const top = writtenLine(100, 1_000);
  const bottom = writtenLine(200, 5_000);

  it("numbers a new page's lines top to bottom and asks for the newest first", () => {
    const result = plan([...bottom, ...top]);
    expect(result.lines.map((l) => [l.lineIndex, l.bbox[1] < 150 ? "top" : "bottom"])).toEqual([
      [0, "top"],
      [1, "bottom"],
    ]);
    expect(result.lines.every((l) => l.recognition === null && l.synced === "")).toBe(true);
    const bottomId = result.lines.find((l) => l.lineIndex === 1)?.id;
    expect(result.toRecognize.map((r) => r.id)).toEqual([bottomId, expect.any(String)]);
  });

  it("uses a recognition this session already has instead of asking again", () => {
    const result = plan(top, [], { known: () => recognised("enzymes \u0007lower\nenergy") });
    expect(result.toRecognize).toEqual([]);
    expect(result.lines[0]?.recognition?.text).toBe("enzymes lower energy");
  });

  it("keeps ids, text and sync state while a line is unchanged, even when it's moved", () => {
    const first = readAll(plan(top).lines).map((l) => ({ ...l, synced: "sent" }));
    const moved = top.map((s) => translateStroke(s, 0, 40));
    const again = plan(moved, first);
    expect(again.lines.map((l) => [l.id, l.recognition?.text, l.synced])).toEqual([
      [first[0]?.id, "a note", "sent"],
    ]);
    expect(again.lines[0]?.bbox[1]).toBeGreaterThan(first[0]?.bbox[1] ?? 0);
    expect(again.toRecognize).toEqual([]);
  });

  it("forgets the text of a line whose strokes changed, but keeps its id", () => {
    const first = readAll(plan(top).lines);
    const extended = [...top, penStroke(160, 100, 1_400)];
    const again = plan(extended, first);
    expect(again.lines[0]?.id).toBe(first[0]?.id);
    expect(again.lines[0]?.recognition).toBeNull();
    expect(again.toRecognize.map((r) => r.id)).toEqual([first[0]?.id]);
  });

  it("drops an erased line the server never had, and keeps one it has until it's removed there", () => {
    const first = readAll(plan([...top, ...bottom]).lines);
    const [topLine, bottomLine] = first;
    const stored = [
      { ...topLine!, synced: "" },
      { ...bottomLine!, synced: "sent" },
    ];
    const erasedBoth = plan([], stored);
    expect(erasedBoth.drop).toEqual([topLine?.id]);
    expect(erasedBoth.lines).toEqual([{ ...bottomLine, synced: "sent", removed: true }]);
  });

  it("turns a clip's text into lines that keep their ids", () => {
    const image = clipImage("Enzymes are catalysts\n\n  They are not consumed  \n");
    const first = plan([], [], { images: [image] });
    expect(
      first.lines.map((l) => [
        l.source,
        l.clipLine,
        l.recognition?.text,
        l.recognition?.confidence,
      ]),
    ).toEqual([
      ["clip", 0, "Enzymes are catalysts", 1],
      ["clip", 1, "They are not consumed", 1],
    ]);
    expect(first.toRecognize).toEqual([]);
    const again = plan([], first.lines, { images: [image] });
    expect(again.lines.map((l) => l.id)).toEqual(first.lines.map((l) => l.id));
  });

  it("numbers clip lines and ink together, in reading order", () => {
    const below = writtenLine(300, 1_000);
    const result = plan(below, [], { images: [clipImage("Slide title\nSlide body")] });
    expect(result.lines.sort((a, b) => a.lineIndex - b.lineIndex).map((l) => l.source)).toEqual([
      "clip",
      "clip",
      "ink",
    ]);
  });
});
