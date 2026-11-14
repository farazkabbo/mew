import type { ConceptProgress, ConceptStatus } from "@mew/shared";
import { describe, expect, it } from "vitest";

import {
  type FolderCourse,
  folderRows,
  folderSummary,
  MAX_TABS,
  notebookFolders,
  orderFolders,
  rowDetail,
  rowKind,
  shortTitle,
  tabSlots,
} from "./review-folders";

const NOW = new Date("2026-11-04T12:00:00Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function progress(n: number, status: ConceptStatus, due: string | null): ConceptProgress {
  return {
    conceptId: id(n),
    status,
    due,
    attempts: 1,
    independent: 0,
    lastAttemptAt: null,
  };
}

function course(n: number, kinds: string, quiz = 0): FolderCourse {
  const map = { r: "revisit", n: "new", h: "hint", c: "checked" } as const;
  return {
    id: id(100 + n),
    title: `Course ${n}`,
    color: "#7DA4AF",
    courseId: id(100 + n),
    checks: 0,
    quiz,
    rows: [...kinds].map((k, i) => ({
      conceptId: id(n * 10 + i),
      title: `Concept ${i}`,
      kind: map[k as keyof typeof map],
      detail: "",
    })),
  };
}

describe("the Review page's folders (decision U25)", () => {
  it("maps conceptStatus to the board's shapes, and leaves out concepts never opened", () => {
    expect(rowKind("revisit")).toBe("revisit");
    expect(rowKind("explored")).toBe("new");
    expect(rowKind("practised_with_hint")).toBe("hint");
    expect(rowKind("checked")).toBe("checked");
    expect(rowKind("not_started")).toBeNull();
  });

  it("orders rows revisit, new, hint, checked, keeping course order within each", () => {
    const concepts = [1, 2, 3, 4, 5, 6].map((n) => ({
      id: id(n),
      title: `C${n}`,
      order_index: n,
    }));
    const rows = folderRows(
      concepts,
      [
        progress(1, "checked", at(5)),
        progress(2, "explored", null),
        progress(3, "revisit", at(-1)),
        progress(4, "practised_with_hint", at(1)),
        progress(5, "revisit", at(-2)),
        // 6 was never opened
      ],
      NOW,
    );
    expect(rows.map((r) => r.title)).toEqual(["C3", "C5", "C2", "C4", "C1"]);
    expect(rows.map((r) => r.detail)).toEqual([
      "Due since yesterday",
      "Due since 2 days ago",
      "Not practised yet",
      "Right with a hint · comes back tomorrow",
      "Comes back in 5 days",
    ]);
  });

  it("words due dates the way the board does", () => {
    expect(rowDetail("revisit", at(-0.2), NOW)).toBe("Due today");
    expect(rowDetail("revisit", at(2), NOW)).toBe("Missed last time");
    expect(rowDetail("checked", at(7), NOW)).toBe("Comes back in 1 week");
    expect(rowDetail("checked", at(20), NOW)).toBe("Comes back in 3 weeks");
  });

  it("sums a folder up, and never calls a hint checked", () => {
    expect(folderSummary(course(1, "rrnc").rows)).toBe("2 to revisit · 1 new · 1 checked");
    expect(folderSummary(course(1, "cc").rows)).toBe("all 2 checked · nothing due");
    expect(folderSummary(course(1, "ch").rows)).toBe("1 checked · 1 with a hint · nothing due");
  });

  it("puts the most to revisit first, then the most new, and an exam's course before all", () => {
    const a = course(1, "rn");
    const b = course(2, "rrc");
    const c = course(3, "rnn");
    const d = course(4, "c");
    expect(orderFolders([d, a, c, b]).map((x) => x.id)).toEqual([b.id, c.id, a.id, d.id]);
    expect(orderFolders([d, a, c, b], d.id)[0]?.id).toBe(d.id);
  });

  it("shows 7 tabs, the rest under More, and a course picked from More takes the last slot", () => {
    const courses = Array.from({ length: 10 }, (_, i) => course(i, "n"));
    expect(tabSlots(courses.slice(0, MAX_TABS), null).more).toEqual([]);
    const { tabs, more } = tabSlots(courses, courses[0]?.id ?? null);
    expect(tabs).toHaveLength(MAX_TABS);
    expect(more.map((c) => c.id)).toEqual(courses.slice(7).map((c) => c.id));
    const picked = courses[9]!;
    const swapped = tabSlots(courses, picked.id);
    expect(swapped.tabs[MAX_TABS - 1]?.id).toBe(picked.id);
    expect(swapped.more.map((c) => c.id)).toEqual([courses[6]!.id, courses[7]!.id, courses[8]!.id]);
  });

  it("labels a tab with the short part of the title", () => {
    expect(shortTitle("EECS 4101 · Advanced Data Structures")).toBe("EECS 4101");
    expect(shortTitle("Physics: Mechanics")).toBe("Physics");
    expect(shortTitle("Business Mathematics")).toBe("Business Mathematics");
  });

  it("makes a folder per notebook: a course takes its notebook's name and colour (U26)", () => {
    const rows = course(1, "rn").rows;
    const folders = notebookFolders(
      [
        { id: id(201), title: "EECS 4101 course", rows, quiz: 2 },
        { id: id(202), title: "Orphan course", rows, quiz: 1 },
        { id: id(203), title: "Nothing started", rows: [], quiz: 0 },
      ],
      [
        { id: id(301), title: "Advanced DSA", color: "#C98B6B", courseId: id(201) },
        { id: id(302), title: "Philosophy", color: "#8FA98B", courseId: null },
        { id: id(303), title: "Empty", color: "#7DA4AF", courseId: null },
      ],
      new Map([
        [id(301), 1],
        [id(302), 2],
      ]),
      () => "#9DB8D9",
    );
    expect(folders.map((f) => [f.id, f.title, f.color, f.courseId, f.quiz, f.checks])).toEqual([
      [id(301), "Advanced DSA", "#C98B6B", id(201), 2, 1],
      // A course no notebook links keeps its own folder, in a colour of its own.
      [id(202), "Orphan course", "#9DB8D9", id(202), 1, 0],
      // A notebook with checks due and no course gets a folder for them.
      [id(302), "Philosophy", "#8FA98B", null, 0, 2],
    ]);
  });

  it("orders by revisit, then new, then checks due; an exam's course still first", () => {
    const a = { ...course(1, "n"), checks: 0 };
    const b = { ...course(2, "n"), checks: 3 };
    const c = { ...course(3, ""), courseId: null, checks: 5 };
    expect(orderFolders([a, c, b]).map((f) => f.id)).toEqual([b.id, a.id, c.id]);
    expect(orderFolders([a, c, b], a.courseId)[0]?.id).toBe(a.id);
  });
});
