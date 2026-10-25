import { type Notebook, type NotebookTree, singular } from "@mew/shared";

/** What a new child of `parentId` is called: "chapter" (or unit, week…) under a notebook,
 * "section" under a chapter. */
export function childNoun(tree: NotebookTree<Notebook>, parentId: string): string {
  const path = tree.path(parentId);
  const root = path[0];
  if (path.length >= 2 || !root) return "section";
  return singular(root.childLabel).toLowerCase();
}

/** What a node is: "notebook", "chapter" (or its label), or "section". */
export function nodeNoun(tree: NotebookTree<Notebook>, id: string): string {
  const path = tree.path(id);
  if (path.length <= 1) return "notebook";
  return childNoun(tree, path[path.length - 2]?.id ?? id);
}

/** "4 chapters and 23 pages", for confirmations and the trash. */
export function contentsText(chapters: number, sections: number, pages: number, noun: string) {
  const parts = [
    chapters > 0 && plural(chapters, noun),
    sections > 0 && plural(sections, "section"),
    pages > 0 && plural(pages, "page"),
  ].filter((part): part is string => Boolean(part));
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
