import { type Notebook, NotebookTree } from "@mew/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { type HomeTab, NodeHome } from "./NodeHome";

const ROOT = "00000000-0000-4000-8000-000000000001";
const CHAPTER = "00000000-0000-4000-8000-000000000002";
const COURSE = "00000000-0000-4000-8000-000000000101";

function node(id: string, parentId: string | null, extra: Partial<Notebook> = {}): Notebook {
  return {
    id,
    title: parentId ? "Chapter 1" : "Advanced DSA",
    parentId,
    position: "a0",
    childLabel: "Chapters",
    editedAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  };
}

function home(
  nodes: Notebook[],
  at: string,
  initialTab?: HomeTab,
  withMoments = false,
  pages: Parameters<typeof NodeHome>[0]["pages"] = [],
) {
  const tree = new NotebookTree(nodes);
  const shown = tree.get(at);
  if (!shown) throw new Error("no such node");
  const moment = {
    clipId: "00000000-0000-4000-8000-000000000201",
    nodeId: at,
  } as unknown as Parameters<typeof NodeHome>[0]["moments"][number];
  return renderToStaticMarkup(
    <NodeHome
      node={shown}
      tree={tree}
      loadCounts={() => Promise.resolve(new Map())}
      pages={pages}
      now={0}
      onOpen={() => undefined}
      onOpenPage={() => undefined}
      onAddChild={() => undefined}
      onAddPage={() => undefined}
      onMovePage={() => undefined}
      onMovePageTo={() => undefined}
      onImportPdf={() => undefined}
      onLinkCourse={() => undefined}
      onQuiz={() => undefined}
      moments={withMoments ? [moment] : []}
      dueCounts={new Map()}
      onOpenMoment={() => undefined}
      onQuickCheck={() => undefined}
      onSetSubject={() => undefined}
      {...(initialTab && { initialTab })}
    />,
  );
}

const tabs = (html: string) => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

describe("a notebook's home is the whole class (decision U26)", () => {
  it("without course material: Pages only, and one card offering to add it", () => {
    const html = home([node(ROOT, null)], ROOT);
    expect(tabs(html)).toEqual(["Pages"]);
    expect(html).toContain('data-testid="add-material"');
    expect(html).toContain("Have the syllabus or slides?");
    expect(html).toContain("Add course material");
  });

  it("with course material: a Study tab, and no card", () => {
    const html = home([node(ROOT, null, { courseId: COURSE })], ROOT);
    expect(tabs(html)).toEqual(["Pages", "Study"]);
    expect(html).not.toContain('data-testid="add-material"');
  });

  it("opens on Study when a course link asks for it", () => {
    const html = home([node(ROOT, null, { courseId: COURSE })], ROOT, "study");
    expect(html).toMatch(/aria-selected="true"[^>]*>Study</);
    expect(html).toContain('aria-label="Study"');
  });

  it("shows Moments once something was saved", () => {
    const html = home([node(ROOT, null)], ROOT, undefined, true);
    expect(tabs(html)).toEqual(["Pages", "Moments"]);
    // Divider tabs carry their count after the label (U28).
    expect(html).toMatch(/>Moments<span[^>]*>1<\/span>/);
  });

  it("keeps the course to the notebook: a chapter has no Study tab and no card", () => {
    const html = home([node(ROOT, null, { courseId: COURSE }), node(CHAPTER, ROOT)], CHAPTER);
    expect(tabs(html)).toEqual(["Pages"]);
    expect(home([node(ROOT, null), node(CHAPTER, ROOT)], CHAPTER)).not.toContain("add-material");
  });

  it("falls back to Pages when asked for a Study tab it doesn't have", () => {
    const html = home([node(ROOT, null)], ROOT, "study");
    expect(html).toMatch(/aria-selected="true"[^>]*>Pages</);
  });

  it("lets a loose page go into a chapter: a move button, and a hint to drag it", () => {
    const page = {
      id: "00000000-0000-4000-8000-000000000401",
      notebookId: ROOT,
      index: 0,
    } as unknown as Parameters<typeof NodeHome>[0]["pages"][number];
    const html = home([node(ROOT, null), node(CHAPTER, ROOT)], ROOT, undefined, false, [page]);
    expect(html).toContain('aria-label="Move page 1 to…"');
    expect(html).toContain("Drag a page onto a chapter to put it there");
    expect(html).toContain('draggable="true"');
    // With no chapters there's nowhere to drag to: no hint (the button still opens the picker).
    const alone = home([node(ROOT, null)], ROOT, undefined, false, [page]);
    expect(alone).not.toContain("Drag a page onto");
    expect(alone).toContain('aria-label="Move page 1 to…"');
  });
});
