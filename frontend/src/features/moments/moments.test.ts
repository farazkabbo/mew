import {
  type ImageBlock,
  type MomentCheckView,
  type Notebook,
  NotebookTree,
  type Page,
} from "@mew/shared";
import { describe, expect, it } from "vitest";

import {
  dueByNode,
  filterMoments,
  momentsFrom,
  openSourceLink,
  sourceKind,
  subtreeIds,
} from "./moments";

const PHYSICS = "00000000-0000-4000-8000-000000000001";
const KINEMATICS = "00000000-0000-4000-8000-000000000013";
const CHEMISTRY = "00000000-0000-4000-8000-000000000002";
const PAGE_K = "11111111-1111-4111-8111-000000000001";
const PAGE_C = "11111111-1111-4111-8111-000000000002";
const SESSION = "22222222-2222-4222-8222-222222222222";

const node = (id: string, title: string, parentId: string | null = null): Notebook => ({
  id,
  title,
  parentId,
  position: "a0",
  childLabel: "Chapters",
  editedAt: 1,
  createdAt: 1,
  updatedAt: 1,
});
const tree = new NotebookTree([
  node(PHYSICS, "Physics"),
  node(KINEMATICS, "Chapter 3 · Kinematics", PHYSICS),
  node(CHEMISTRY, "Chemistry"),
]);
const page = (id: string, notebookId: string): Page => ({
  id,
  notebookId,
  index: 0,
  background: "dot_grid",
  createdAt: 1,
  fromScreen: 1,
});

function entry(
  n: number,
  pageId: string,
  question: string,
  source: ImageBlock["source"],
  ocrText?: string,
): ImageBlock {
  return {
    id: `33333333-3333-4333-8333-00000000000${n}`,
    pageId,
    type: "image",
    clipId: `44444444-4444-4444-8444-00000000000${n}`,
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    ...(source && { source }),
    ...(ocrText && { ocrText }),
    entry: {
      sessionId: SESSION,
      turns: [{ question, steps: ["A step."], summary: "Projectile motion is a parabola." }],
      stepGroups: [[]],
      strokeCount: 0,
    },
    createdAt: n,
  };
}

const VIDEO = {
  app: "msedge.exe",
  title: "Projectile motion lecture",
  url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754",
  timestampSec: 754,
  capturedAt: "2026-10-26T09:00:00Z",
};
const WEB = {
  app: "msedge.exe",
  title: "Bonds",
  url: "https://chem.example/bonds",
  capturedAt: "2026-10-26T09:00:00Z",
};

describe("moments on this device (K8 §4.7)", () => {
  const images = [
    entry(1, PAGE_K, "Why is this curved?", VIDEO),
    entry(2, PAGE_C, "What's a covalent bond?", WEB, "A covalent bond — two atoms share\nmore"),
    // A plain clip isn't a moment.
    { ...entry(3, PAGE_K, "x", undefined), entry: undefined },
  ];
  const moments = momentsFrom(images, [page(PAGE_K, KINEMATICS), page(PAGE_C, CHEMISTRY)]);

  it("lists entries newest first, on the node their page is in", () => {
    expect(moments.map((m) => [m.question, m.nodeId, m.kind])).toEqual([
      ["What's a covalent bond?", CHEMISTRY, "web"],
      ["Why is this curved?", KINEMATICS, "video"],
    ]);
  });

  it("filters by place (a notebook includes its chapters), words and source", () => {
    const physics = subtreeIds(tree, PHYSICS);
    expect(filterMoments(moments, { nodeIds: physics }).map((m) => m.nodeId)).toEqual([KINEMATICS]);
    expect(filterMoments(moments, { query: "parabola curved" })).toHaveLength(1);
    expect(filterMoments(moments, { query: "lecture" })[0]?.kind).toBe("video");
    expect(filterMoments(moments, { kind: "web" })).toHaveLength(1);
    expect(filterMoments(moments, { query: "mitosis" })).toEqual([]);
  });

  it("opens a video at its second and a web page at the circled words", () => {
    expect(openSourceLink(images[0] as ImageBlock)).toBe(VIDEO.url);
    expect(openSourceLink(images[1] as ImageBlock)).toBe(
      "https://chem.example/bonds#:~:text=A%20covalent%20bond%20two%20atoms%20share",
    );
    const hyphen = entry(4, PAGE_C, "q", WEB, "well-known three-body problem here");
    expect(openSourceLink(hyphen)).toContain("well%2Dknown%20three%2Dbody");
    // Not https, or another app: no link.
    expect(openSourceLink(entry(5, PAGE_C, "q", { ...WEB, url: "http://chem.example" }))).toBe(
      null,
    );
    expect(openSourceLink(entry(6, PAGE_C, "q", { app: "WINWORD.EXE", capturedAt: "x" }))).toBe(
      null,
    );
  });

  it("tells a PDF from a web page by its link or its window title", () => {
    expect(sourceKind({ ...WEB, url: "https://uni.example/notes/week3.PDF" })).toBe("pdf");
    expect(sourceKind({ app: "Acrobat.exe", title: "week3.pdf - Adobe", capturedAt: "x" })).toBe(
      "pdf",
    );
    expect(sourceKind({ app: "Code.exe", capturedAt: "x" })).toBe("app");
  });
});

describe("checks due per chapter (K8 §4.7)", () => {
  const check = (nodeId: string | null, dueAt: string): MomentCheckView => ({
    id: crypto.randomUUID(),
    clipId: crypto.randomUUID(),
    nodeId,
    prompt: "Why?",
    kind: "short",
    choices: [],
    conceptHints: [],
    isNew: true,
    dueAt,
    createdAt: "2026-10-25T09:00:00Z",
  });

  it("counts what's due on the chapter and the notebook above it, not what's later", () => {
    const now = Date.parse("2026-10-26T12:00:00Z");
    const counts = dueByNode(
      [
        check(KINEMATICS, "2026-10-26T09:00:00Z"),
        check(KINEMATICS, "2026-10-26T11:00:00Z"),
        check(KINEMATICS, "2026-10-30T09:00:00Z"),
        check(null, "2026-10-26T09:00:00Z"),
      ],
      tree,
      now,
    );
    expect(counts.get(KINEMATICS)).toBe(2);
    expect(counts.get(PHYSICS)).toBe(2);
    expect(counts.get(CHEMISTRY)).toBeUndefined();
  });
});
