import { type Notebook, NotebookTree } from "@mew/shared";
import { describe, expect, it } from "vitest";

import { planVoice } from "./voice-plan";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, title: string, parent: number | null, position = "a0"): Notebook => ({
  id: id(n),
  title,
  parentId: parent === null ? null : id(parent),
  position,
  childLabel: "Chapters",
  editedAt: 0,
  createdAt: 0,
  updatedAt: 0,
});
const nodes = [
  node(1, "Physics", null, "a0"),
  node(2, "Chapter 1", 1, "a0"),
  node(3, "Chapter 2", 1, "a1"),
  node(4, "Chemistry", null, "a1"),
  node(5, "Unit 1", 4, "a0"),
];
const tree = new NotebookTree(nodes);
const page = "10000000-0000-4000-8000-000000000001";
const at = (nodeId: string | null, pageId: string | null = page) => ({
  tree,
  nodes,
  nodeId,
  pageId,
});

describe("what the notebook does with notebook words (K3 §4.5)", () => {
  it("moves the page on screen where the student says", () => {
    expect(
      planVoice("save_to_notebook", "save it to physics chapter 2", undefined, at(id(5))),
    ).toEqual({
      kind: "move_page",
      pageId: page,
      nodeId: id(3),
      path: ["Physics", "Chapter 2"],
    });
    // The gate's own phrase wins.
    expect(
      planVoice("save_to_notebook", "put it there", "chemistry unit 1", at(id(2))),
    ).toMatchObject({ kind: "move_page", nodeId: id(5) });
  });

  it("offers to make a missing chapter, and asks when it's unclear", () => {
    expect(
      planVoice("save_to_notebook", "save it to physics chapter 5", undefined, at(id(2))),
    ).toEqual({
      kind: "offer_create",
      pageId: page,
      parentId: id(1),
      title: "Chapter 5",
      path: ["Physics"],
    });
    expect(planVoice("save_to_notebook", "save it to geography", undefined, at(id(2)))).toEqual({
      kind: "pick_page",
      pageId: page,
    });
    expect(planVoice("save_to_notebook", "save it", undefined, at(id(2), null))).toMatchObject({
      kind: "say",
    });
  });

  it("renames, makes and moves by voice, and never deletes", () => {
    expect(
      planVoice("notebook_command", "rename this chapter to Optics", undefined, at(id(3))),
    ).toEqual({
      kind: "rename",
      nodeId: id(3),
      title: "Optics",
    });
    expect(
      planVoice("notebook_command", "make a new notebook called Biology", undefined, at(id(3))),
    ).toEqual({ kind: "create_notebook", title: "Biology" });
    expect(
      planVoice("notebook_command", "create a chapter called Waves", undefined, at(id(1))),
    ).toEqual({ kind: "create_child", parentId: id(1), title: "Waves" });
    expect(
      planVoice(
        "notebook_command",
        "create a chapter called Waves in chemistry",
        undefined,
        at(id(1)),
      ),
    ).toEqual({ kind: "create_child", parentId: id(4), title: "Waves" });
    expect(
      planVoice("notebook_command", "move this chapter to chemistry", undefined, at(id(3))),
    ).toEqual({
      kind: "move_node",
      nodeId: id(3),
      parentId: id(4),
      path: ["Chemistry"],
    });
    expect(
      planVoice("notebook_command", "delete this chapter", undefined, at(id(3))),
    ).toMatchObject({
      kind: "say",
      text: expect.stringContaining("never delete by voice"),
    });
  });
});
