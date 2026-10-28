import { PageDocument, strokeBBox } from "@mew/ink";
import type { HandwritingSampleInput, Point, Stroke } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { studentLines } from "../notebook/export-line";
import { HandwritingTeacher } from "./teach";

function page() {
  const points: Point[] = [
    [10, 40, 0.5, 0],
    [20, 10, 0.5, 10],
    [30, 40, 0.5, 20],
  ];
  const stroke: Stroke = {
    id: "00000000-0000-4000-8000-000000000001",
    pageId: "11111111-1111-4111-8111-111111111111",
    author: "student",
    tool: "pen",
    points,
    color: "#1d1c1a",
    width: 3,
    bbox: strokeBBox(points, 3),
    createdAt: 1,
  };
  const doc = new PageDocument([stroke]);
  const line = studentLines(doc)[0];
  if (!line) throw new Error("no line");
  return { doc, line };
}

const collect = () => {
  const sent: HandwritingSampleInput[][] = [];
  const send = (s: HandwritingSampleInput[]) => {
    sent.push(s);
    return Promise.resolve();
  };
  return { sent, send };
};

describe("HandwritingTeacher", () => {
  it("sends the line's picture with what it really says", async () => {
    const { sent, send } = collect();
    const { doc, line } = page();
    const teacher = new HandwritingTeacher(() => true, send);
    const fix = { text: " 7 ", latex: "7", readAs: "1", source: "fix" } as const;
    expect(await teacher.teach(doc, line, fix)).toBe(true);
    expect(sent[0]?.[0]).toMatchObject({ text: "7", latex: "7", readAs: "1", source: "fix" });
    expect(sent[0]?.[0]?.image.startsWith("iVBORw0KGgo")).toBe(true);
  });

  it("drops readAs when it was read right, and sends nothing when learning is off", async () => {
    const { sent, send } = collect();
    const { doc, line } = page();
    const confirm = { text: "7", latex: null, readAs: "7", source: "confirm" } as const;
    await new HandwritingTeacher(() => true, send).teach(doc, line, confirm);
    expect(sent[0]?.[0]?.readAs).toBeNull();
    expect(await new HandwritingTeacher(() => false, send).teach(doc, line, confirm)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("never throws when the server refuses", async () => {
    const { doc, line } = page();
    const teacher = new HandwritingTeacher(
      () => true,
      () => Promise.reject(new Error("429")),
    );
    const fix = { text: "7", latex: null, readAs: null, source: "fix" } as const;
    expect(await teacher.teach(doc, line, fix)).toBe(false);
  });
});
