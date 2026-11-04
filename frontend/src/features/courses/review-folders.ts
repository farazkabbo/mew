import type { ConceptProgress, ConceptStatus } from "@mew/shared";

/**
 * The Review page's folders (docs/NEB_APP_UI.md decisions U25 and U26, boards 7 and 8): one per
 * notebook (its course's concepts and its checks due), which concepts each lists, in what order,
 * and the order of the tabs. Pure, so the page and /dev/ui render the same thing.
 */

/** A row's shape on the board; `hint` is right with help, not yet checked. */
export type RowKind = "revisit" | "new" | "hint" | "checked";

export type FolderRow = { conceptId: string; title: string; kind: RowKind; detail: string };

export type FolderCourse = {
  /** The notebook's id, or the course's for a course with no notebook. */
  id: string;
  title: string;
  /** The notebook's cover colour (a CSS colour). */
  color: string;
  /** The notebook's course, when it has one (its concepts, lessons and Quiz me). */
  courseId: string | null;
  rows: FolderRow[];
  /** Concepts in the review queue: what "Quiz me" asks about. */
  quiz: number;
  /** Checks due from moments saved in the notebook (K8): its own Quick check. */
  checks: number;
};

/** A course as Review read it: its started concepts and what's in the review queue. */
export type CourseInput = { id: string; title: string; rows: FolderRow[]; quiz: number };

/** A notebook on this device (a root of the tree). */
export type NotebookInput = { id: string; title: string; color: string; courseId: string | null };

/**
 * U26: a folder per notebook. A course takes its notebook's name and colour; a notebook with
 * nothing but checks due gets a folder for them; a course no notebook links keeps its own
 * (`colorFor` picks its colour). Folders with nothing in them are left out.
 */
export function notebookFolders(
  courses: readonly CourseInput[],
  notebooks: readonly NotebookInput[],
  checksByNotebook: ReadonlyMap<string, number>,
  colorFor: (courseId: string) => string,
): FolderCourse[] {
  const byCourse = new Map<string, NotebookInput>();
  for (const notebook of notebooks) {
    if (notebook.courseId && !byCourse.has(notebook.courseId)) {
      byCourse.set(notebook.courseId, notebook);
    }
  }
  const used = new Set<string>();
  const folders: FolderCourse[] = [];
  for (const course of courses) {
    const notebook = byCourse.get(course.id);
    if (notebook) used.add(notebook.id);
    const checks = notebook ? (checksByNotebook.get(notebook.id) ?? 0) : 0;
    if (course.rows.length === 0 && course.quiz === 0 && checks === 0) continue;
    folders.push({
      id: notebook?.id ?? course.id,
      title: notebook?.title ?? course.title,
      color: notebook?.color ?? colorFor(course.id),
      courseId: course.id,
      rows: course.rows,
      quiz: course.quiz,
      checks,
    });
  }
  for (const notebook of notebooks) {
    const checks = checksByNotebook.get(notebook.id) ?? 0;
    if (used.has(notebook.id) || checks === 0) continue;
    folders.push({
      id: notebook.id,
      title: notebook.title,
      color: notebook.color,
      courseId: null,
      rows: [],
      quiz: 0,
      checks,
    });
  }
  return folders;
}

/** Tabs shown before the rest go under "More". */
export const MAX_TABS = 7;

/** How long a folder takes to come out of the stack (the board's pullOut). */
export const PULL_MS = 640;

const ORDER: Record<RowKind, number> = { revisit: 0, new: 1, hint: 2, checked: 3 };
const DAY = 86_400_000;

/** A concept's row from its status (`conceptStatus`); never-opened concepts have none. */
export function rowKind(status: ConceptStatus): RowKind | null {
  switch (status) {
    case "revisit":
      return "revisit";
    case "explored":
      return "new";
    case "practised_with_hint":
      return "hint";
    case "checked":
      return "checked";
    case "not_started":
      return null;
  }
}

function comesBack(due: string | null, now: Date): string {
  if (!due) return "comes back soon";
  const days = Math.ceil((Date.parse(due) - now.getTime()) / DAY);
  if (days <= 0) return "comes back today";
  if (days === 1) return "comes back tomorrow";
  if (days < 7) return `comes back in ${days} days`;
  const weeks = Math.round(days / 7);
  return weeks === 1 ? "comes back in 1 week" : `comes back in ${weeks} weeks`;
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Due since yesterday", "Not practised yet", "Comes back in 5 days". */
export function rowDetail(kind: RowKind, due: string | null, now: Date): string {
  switch (kind) {
    case "revisit": {
      if (!due || Date.parse(due) > now.getTime()) return "Missed last time";
      const days = Math.floor((now.getTime() - Date.parse(due)) / DAY);
      if (days <= 0) return "Due today";
      return days === 1 ? "Due since yesterday" : `Due since ${days} days ago`;
    }
    case "new":
      return "Not practised yet";
    case "hint":
      return `Right with a hint · ${comesBack(due, now)}`;
    case "checked":
      return capital(comesBack(due, now));
  }
}

/** A course's rows: every concept it has started, revisit first, then new, hint and checked. */
export function folderRows(
  concepts: readonly { id: string; title: string; order_index: number }[],
  progress: readonly ConceptProgress[],
  now: Date,
): FolderRow[] {
  const byId = new Map(progress.map((p) => [p.conceptId, p]));
  const rows: FolderRow[] = [];
  for (const concept of [...concepts].sort((a, b) => a.order_index - b.order_index)) {
    const known = byId.get(concept.id);
    const kind = rowKind(known?.status ?? "not_started");
    if (!kind) continue;
    rows.push({
      conceptId: concept.id,
      title: concept.title,
      kind,
      detail: rowDetail(kind, known?.due ?? null, now),
    });
  }
  return rows.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]); // stable: course order within a kind
}

export function countRows(rows: readonly FolderRow[]): Record<RowKind, number> {
  const counts: Record<RowKind, number> = { revisit: 0, new: 0, hint: 0, checked: 0 };
  for (const row of rows) counts[row.kind] += 1;
  return counts;
}

/** "2 to revisit · 1 new · 1 checked", or "all 2 checked · nothing due". */
export function folderSummary(rows: readonly FolderRow[]): string {
  const { revisit, new: fresh, hint, checked } = countRows(rows);
  if (rows.length === 0) return "no course material yet";
  const parts: string[] = [];
  if (revisit) parts.push(`${revisit} to revisit`);
  if (fresh) parts.push(`${fresh} new`);
  if (!revisit && !fresh) {
    if (!hint) return `all ${checked} checked · nothing due`;
    if (checked) parts.push(`${checked} checked`);
    parts.push(`${hint} with a hint`, "nothing due");
    return parts.join(" · ");
  }
  if (hint) parts.push(`${hint} with a hint`);
  if (checked) parts.push(`${checked} checked`);
  return parts.join(" · ");
}

/**
 * Most to revisit first, then most new, then most checks due; the folder of a course with an exam
 * close comes first of all (`firstId` is that course's id).
 */
export function orderFolders(
  courses: readonly FolderCourse[],
  firstId: string | null = null,
): FolderCourse[] {
  const key = (course: FolderCourse) => countRows(course.rows);
  return [...courses].sort((a, b) => {
    if (firstId && a.courseId === firstId) return -1;
    if (firstId && b.courseId === firstId) return 1;
    const ka = key(a);
    const kb = key(b);
    return (
      kb.revisit - ka.revisit ||
      kb.new - ka.new ||
      b.checks - a.checks ||
      a.title.localeCompare(b.title, undefined)
    );
  });
}

/** The tab's label: "EECS 4101" from "EECS 4101 · Advanced Data Structures". */
export function shortTitle(title: string): string {
  const [head] = title.split(/ [·–—-] |: /);
  return (head ?? title).trim() || title;
}

/**
 * Which folders get a tab. Past `MAX_TABS`, the rest are under "More"; one picked from there
 * takes the last slot while it's open.
 */
export function tabSlots(
  courses: readonly FolderCourse[],
  activeId: string | null,
): { tabs: FolderCourse[]; more: FolderCourse[] } {
  if (courses.length <= MAX_TABS) return { tabs: [...courses], more: [] };
  const tabs = courses.slice(0, MAX_TABS);
  if (activeId && !tabs.some((c) => c.id === activeId)) {
    const active = courses.find((c) => c.id === activeId);
    if (active) tabs[MAX_TABS - 1] = active;
  }
  const shown = new Set(tabs.map((c) => c.id));
  return { tabs, more: courses.filter((c) => !shown.has(c.id)) };
}

/** A stable cover colour for a course with no notebook of its own. */
export function fallbackColor(courseId: string, palette: readonly string[]): string {
  let hash = 0;
  for (const char of courseId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length] ?? palette[0] ?? "var(--line)";
}
