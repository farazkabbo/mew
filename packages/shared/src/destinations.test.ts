import { describe, expect, it } from "vitest";

import {
  type DestinationNode,
  type DestinationResolution,
  looksDescriptive,
  parseNotebookCommand,
  phraseSegments,
  resolveDestination,
  splitDestination,
} from "./destinations";

/** A student's tree: two physics notebooks, chemistry by units, biology by weeks, sections. */
const ids = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let next = 1;
const nodes: DestinationNode[] = [];
function node(
  title: string,
  parentId: string | null = null,
  extra: Partial<DestinationNode> = {},
): string {
  const id = ids(next++);
  const position = `a${String(nodes.filter((n) => n.parentId === parentId).length).padStart(2, "0")}`;
  nodes.push({ id, parentId, title, position, ...extra });
  return id;
}
const physics = node("Physics");
const kinematics = node("Chapter 1 · Kinematics", physics);
const projectile = node("1.2 Projectile motion", kinematics, { childLabel: "Chapters" });
node("1.1 Motion in a line", kinematics);
const forces = node("Chapter 2 · Forces", physics);
const energy = node("Chapter 3 · Energy", physics);
const momentum = node("Chapter 4 · Momentum", physics);
const physicsII = node("Physics II");
const physicsIIch1 = node("Chapter 1", physicsII);
const optics = node("Optics", physicsII);
const chemistry = node("Chemistry", null, { childLabel: "Units" });
const chemUnit1 = node("Unit 1 - Atoms", chemistry);
const chemUnit2 = node("Unit 2 - Bonding", chemistry);
const chemUnit3 = node("Unit 3 - Reactions", chemistry);
const biology = node("Biology", null, { childLabel: "Weeks" });
const bioWeek1 = node("Week 1", biology);
const bioWeek2 = node("Week 2", biology);
const cells = node("Cells and tissues", biology);
const history = node("History of science");
const essays = node("Essays", history);
const maths = node("Maths");
const calculus = node("Calculus", maths);
const algebra = node("Linear algebra", maths);
const old = node("Old notebook", null, { deletedAt: 1 });
const oldChapter = node("Chapter 9", old);

const resolved = (r: DestinationResolution) =>
  r.kind === "resolved" ? r.destination.nodeId : null;
const choices = (r: DestinationResolution) =>
  r.kind === "ambiguous" ? r.choices.map((c) => c.nodeId) : [];

describe("resolving where to save (K3 §4.3)", () => {
  const cases: [string, string][] = [
    ["physics", physics],
    ["my physics notebook", physics],
    ["Physics.", physics],
    ["phys", physics],
    ["physics chapter 1 kinematics", kinematics],
    ["physics, the kinematics one", kinematics],
    ["physics ch 2", forces],
    ["phys ch2", forces],
    ["physics chap. 3", energy],
    ["physics, chapter four", momentum],
    ["chapter 4 of physics", momentum],
    ["chapter four in my physics notebook", momentum],
    ["the fourth chapter of physics", momentum],
    ["physics chapter iv", momentum],
    ["the kinematics chapter in physics", kinematics],
    ["kinematics", kinematics],
    ["the forces chapter", forces],
    ["energy in physics", energy],
    ["projectile motion", projectile],
    ["section 1.2 of physics", projectile],
    ["projectile motion in kinematics", projectile],
    ["physics 2", physicsII],
    ["physics ii", physicsII],
    ["optics", optics],
    ["the optics chapter of physics ii", optics],
    ["chem", chemistry],
    ["my chemistry notebook please", chemistry],
    ["unit 3 in chem", chemUnit3],
    ["chemistry unit two", chemUnit2],
    ["chem unit 1", chemUnit1],
    ["bonding", chemUnit2],
    ["the reactions unit", chemUnit3],
    ["chapter 3 of chemistry", chemUnit3],
    ["my bio notebook", biology],
    ["biology", biology],
    ["bio week 2", bioWeek2],
    ["week 1 of biology", bioWeek1],
    ["cells", cells],
    ["cells and tissues in biology", cells],
    ["history of science", history],
    ["the essays in history of science", essays],
    ["essays", essays],
    ["maths", maths],
    ["calculus", calculus],
    ["math calculus", calculus],
    ["linear algebra", algebra],
    ["algebra in maths", algebra],
  ];
  it.each(cases)("%s", (phrase, expected) => {
    const result = resolveDestination(phrase, nodes);
    expect(resolved(result), JSON.stringify(result)).toBe(expected);
  });

  it("says where it goes, with the path from the notebook down", () => {
    const result = resolveDestination("my physics notebook, chapter 2", nodes);
    expect(result).toMatchObject({
      kind: "resolved",
      destination: {
        nodeId: forces,
        path: ["Physics", "Chapter 2 · Forces"],
        page: { kind: "from_screen" },
        method: "exact",
      },
    });
    expect(resolveDestination("phys ch2", nodes)).toMatchObject({
      kind: "resolved",
      destination: { nodeId: forces, method: "fuzzy" },
    });
    const exact = resolveDestination("Biology", nodes);
    expect(exact).toMatchObject({ kind: "resolved", destination: { method: "exact" } });
  });

  it("offers chips when two places fit about as well (never a guess)", () => {
    // Physics and Physics II both have a Chapter 1 (the brief's own example).
    for (const phrase of ["physics chapter 1", "physics chapter one"]) {
      const both = resolveDestination(phrase, nodes);
      expect(both.kind, phrase).toBe("ambiguous");
      expect(choices(both)).toEqual([kinematics, physicsIIch1]);
    }
    // Physics and Physics II both have a chapter 1.
    const result = resolveDestination("physics chapter 1", [
      ...nodes.filter((n) => n.id !== kinematics),
      { id: kinematics, parentId: physics, title: "Chapter 1", position: "a00" },
    ]);
    expect(result.kind).toBe("ambiguous");
    expect(choices(result)).toEqual(expect.arrayContaining([kinematics, physicsIIch1]));
    expect(choices(result).length).toBeLessThanOrEqual(3);
  });

  it("offers to make a chapter that isn't there yet (and never makes it itself)", () => {
    for (const phrase of [
      "physics chapter 5",
      "my physics notebook, chapter five",
      "chapter 5 of physics",
    ]) {
      const result = resolveDestination(phrase, nodes);
      expect(result, phrase).toEqual({
        kind: "missing",
        parentId: physics,
        parentPath: ["Physics"],
        title: "Chapter 5",
        page: { kind: "from_screen" },
      });
    }
    // Chemistry calls its chapters units.
    expect(resolveDestination("chemistry unit 7", nodes)).toMatchObject({
      kind: "missing",
      parentId: chemistry,
      title: "Unit 7",
    });
    // A named chapter.
    expect(resolveDestination("the waves chapter in physics", nodes)).toMatchObject({
      kind: "missing",
      parentId: physics,
      title: "Waves",
    });
  });

  it("finds nothing for places the student doesn't have", () => {
    for (const phrase of ["geography", "my spanish notebook", "the old notebook chapter 9", ""]) {
      const result = resolveDestination(phrase, nodes);
      expect(result.kind === "none" || result.kind === "missing", phrase).toBe(true);
      expect(resolved(result)).toBeNull();
    }
    // Trashed notebooks and their chapters are never destinations.
    expect(resolved(resolveDestination("chapter 9", nodes))).not.toBe(oldChapter);
  });

  it("reads a bare chapter number in the open notebook", () => {
    expect(resolved(resolveDestination("chapter 2", nodes, { currentNodeId: energy }))).toBe(
      forces,
    );
    expect(resolved(resolveDestination("unit 2", nodes, { currentNodeId: chemistry }))).toBe(
      chemUnit2,
    );
    // Without an open notebook, "chapter 1" fits several notebooks: chips.
    expect(resolveDestination("chapter 1", nodes).kind).toBe("ambiguous");
  });

  it("prefers recent destinations when it's otherwise close", () => {
    const tied = [
      ...nodes.filter((n) => n.id !== kinematics),
      { id: kinematics, parentId: physics, title: "Chapter 1", position: "a00" },
    ];
    const without = resolveDestination("physics chapter 1", tied);
    expect(without.kind).toBe("ambiguous");
    const recent = resolveDestination("physics chapter 1", tied, { recentNodeIds: [kinematics] });
    expect(choices(recent)[0] ?? resolved(recent)).toBe(kinematics);
  });

  it("knows which page: From screen, a new page, or page n", () => {
    const page = (phrase: string) => {
      const r = resolveDestination(phrase, nodes);
      return r.kind === "resolved" ? r.destination.page : null;
    };
    expect(page("physics chapter 2")).toEqual({ kind: "from_screen" });
    expect(page("physics chapter 2 on page 3")).toEqual({ kind: "number", number: 3 });
    expect(page("on a new page in physics chapter 2")).toEqual({ kind: "new" });
    expect(resolved(resolveDestination("physics chapter 2 on page 3", nodes))).toBe(forces);
  });

  it("splits phrases into segments", () => {
    expect(phraseSegments("physics chapter 5")).toEqual([
      { name: "physics", number: null, level: null },
      { name: null, number: "5", level: "chapter" },
    ]);
    expect(phraseSegments("the kinematics chapter in physics")).toEqual([
      { name: "physics", number: null, level: null },
      { name: "kinematics", number: null, level: "chapter" },
    ]);
    expect(phraseSegments("chapter twenty one")).toEqual([
      { name: null, number: "21", level: "chapter" },
    ]);
  });
});

describe("taking the destination out of what was said (K3 §4.2)", () => {
  it.each([
    [
      "why is this the hypotenuse? save it to my physics notebook chapter 5",
      "why is this the hypotenuse?",
      "my physics notebook chapter 5",
    ],
    ["Explain this and save it to Physics chapter 5.", "Explain this", "Physics chapter 5"],
    ["explain this and save it in chem ch 2", "explain this", "chem ch 2"],
    ["save it to physics chapter 5", "", "physics chapter 5"],
    ["save to physics ch 5", "", "physics ch 5"],
    ["Save this to Chemistry chapter 2!", "", "Chemistry chapter 2"],
    ["put it in my bio notebook", "", "my bio notebook"],
    [
      "what does this mean, then file it under week 2 of biology",
      "what does this mean",
      "week 2 of biology",
    ],
    ["save this to physics chapter 5 and explain it", "explain it", "physics chapter 5"],
    ["put it in context for me and then save it to maths", "put it in context for me", "maths"],
  ])("%s", (said, question, phrase) => {
    expect(splitDestination(said)).toMatchObject({ question, phrase });
  });

  it("leaves questions about saving alone", () => {
    for (const said of [
      "how do I save this to PDF?",
      "how do I save this file to my desktop",
      "can I save it to the cloud?",
      "why does this formula work",
      "what is the save button for",
      "",
    ]) {
      expect(splitDestination(said), said).toBeNull();
    }
  });

  it("marks phrases that look like a notebook place", () => {
    expect(splitDestination("save it to my physics notebook")?.cued).toBe(true);
    expect(splitDestination("save it to physics ch5")?.cued).toBe(true);
    expect(splitDestination("save it to physics")?.cued).toBe(false); // the tree decides
  });

  it("knows a description from a name", () => {
    expect(looksDescriptive("the one about forces")).toBe(true);
    expect(looksDescriptive("physics chapter 5")).toBe(false);
  });
});

describe("notebook commands by voice (K3 §4.5)", () => {
  it.each([
    ["rename this chapter to Optics", { kind: "rename", title: "Optics" }],
    ["Rename this notebook as Physics 101.", { kind: "rename", title: "Physics 101" }],
    ["call this chapter Waves", { kind: "rename", title: "Waves" }],
    [
      "create a chapter called Optics in physics",
      { kind: "create", level: "child", title: "Optics", parentPhrase: "physics" },
    ],
    [
      "make a new notebook called Biology",
      { kind: "create", level: "notebook", title: "Biology", parentPhrase: null },
    ],
    ["new unit Stoichiometry", { kind: "create", level: "child", title: "Stoichiometry" }],
    ["move this chapter to Physics II", { kind: "move", phrase: "Physics II" }],
    ["move this page to chemistry unit 2", { kind: "move", phrase: "chemistry unit 2" }],
    ["delete this chapter", { kind: "delete_refused" }],
    ["Neb, remove my physics notebook", { kind: "delete_refused" }],
  ])("%s", (said, command) => {
    expect(parseNotebookCommand(said)).toMatchObject(command);
  });

  it("isn't a command otherwise", () => {
    for (const said of ["what does rename mean in git", "add this up", "why do objects move"]) {
      expect(parseNotebookCommand(said), said).toBeNull();
    }
  });
});
