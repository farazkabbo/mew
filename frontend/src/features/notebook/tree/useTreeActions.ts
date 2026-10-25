"use client";

import type { Notebook, NotebookTree, Page } from "@mew/shared";
import { useCallback, useState } from "react";

import type { NotebookRepository } from "../repository";
import type { NewNotebook } from "../tree-repository";
import { childNoun, contentsText, nodeNoun } from "./tree-labels";

/** A message for the student, with an optional button (Undo). */
export type TreeNoticeView = {
  text: string;
  tone: "info" | "error";
  action?: { label: string; run(): void };
};

type Options = {
  repo: NotebookRepository;
  tree: NotebookTree<Notebook>;
  notify(notice: TreeNoticeView): void;
  report(error: unknown): void;
  openNode(id: string): void;
  openPage(page: Page): void;
};

const MOVE_REFUSED = {
  depth: "That would make more than three levels (notebook › chapter › section).",
  cycle: "A notebook can't go inside itself.",
  missing: "That place isn't there any more.",
} as const;

/**
 * Everything the student can do to the notebook tree (K1, docs/NOTEBOOKS_K.md §2.2–2.3), as
 * handlers for the sidebar, the home view, the dialogs and the shortcuts, plus those dialogs'
 * state. Renames, moves and deletes say what happened and offer Undo.
 */
export function useTreeActions({ repo, tree, notify, report, openNode, openPage }: Options) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Pick<Notebook, "title" | "icon" | "color"> | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; title: string; body: string } | null>(
    null,
  );
  const [trashOpen, setTrashOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const run = useCallback(
    <T>(work: Promise<T>, then: (value: T) => void) => void work.then(then).catch(report),
    [report],
  );

  const startCreating = useCallback(() => {
    setRenamingId(null);
    setCreating(true);
  }, []);

  const cancelCreating = useCallback(() => {
    setCreating(false);
    setDraft(null);
  }, []);

  const createNotebook = (input: NewNotebook) =>
    run(repo.tree.createNotebook(input), (notebook) => {
      setCreating(false);
      setDraft(null);
      openNode(notebook.id);
    });

  /** A new chapter (or section) under `parentId`, opened with its name ready to type. */
  const addChild = (parentId: string) =>
    run(repo.tree.addChild(parentId), (child) => {
      if (!child) {
        notify({ text: "Sections can't hold sections: three levels at most.", tone: "info" });
        return;
      }
      openNode(child.id);
      setRenamingId(child.id);
    });

  const addPage = (nodeId: string) => run(repo.addPage(nodeId), openPage);

  /** Resolves to an error to show beside the field, or null when it's renamed. */
  const rename = async (id: string, raw: string): Promise<string | null> => {
    try {
      const result = await repo.tree.rename(id, raw);
      if (!result.ok) {
        return result.reason === "taken"
          ? `That name is taken here. Try “${result.suggestion}”.`
          : "Names are 1 to 80 characters.";
      }
      setRenamingId(null);
      const title = raw.replace(/\s+/g, " ").trim();
      if (result.previous !== title) {
        notify({
          text: `Renamed to “${title}”.`,
          tone: "info",
          action: { label: "Undo", run: () => void rename(id, result.previous) },
        });
      }
      return null;
    } catch (error) {
      report(error);
      return "Couldn't rename it. Try again.";
    }
  };

  const move = (id: string, parentId: string | null, index: number) =>
    run(repo.tree.move(id, parentId, index), (result) => {
      if (!result.ok) notify({ text: MOVE_REFUSED[result.reason], tone: "error" });
      else if (result.renamedTo) {
        notify({
          text: `A sibling had that name, so it's now “${result.renamedTo}”.`,
          tone: "info",
        });
      }
    });

  const reorder = (id: string, step: -1 | 1) => run(repo.tree.reorder(id, step), () => undefined);

  const trash = (id: string) => {
    const title = tree.get(id)?.title ?? "it";
    run(repo.tree.trash(id), () =>
      notify({
        text: `Moved “${title}” to the trash.`,
        tone: "info",
        action: { label: "Undo", run: () => restore(id) },
      }),
    );
  };

  /** Deletes to the trash; asks first when there's something inside. */
  const requestDelete = (id: string) => {
    const node = tree.get(id);
    if (!node) return;
    const below = tree.descendants(id).filter((n) => n.deletedAt === undefined);
    run(repo.countPages([id, ...below.map((n) => n.id)]), (counts) => {
      const pages = [...counts.values()].reduce((sum, n) => sum + n, 0);
      const chapters = below.filter((n) => n.parentId === id).length;
      const sections = below.length - chapters;
      if (below.length === 0 && pages <= 1) {
        trash(id);
        return;
      }
      const noun = tree.depth(id) === 0 ? childNoun(tree, id) : "section";
      setDeleting({
        id,
        title: `Delete ${nodeNoun(tree, id)} “${node.title}”?`,
        body: `It has ${contentsText(chapters, sections, pages, noun)}. It goes to the trash, where you can restore it for 30 days.`,
      });
    });
  };

  const restore = (id: string) =>
    run(repo.tree.restore(id), ({ renamedTo }) => {
      if (renamedTo) {
        notify({ text: `Restored as “${renamedTo}” (the name was taken).`, tone: "info" });
      }
    });

  const deleteForever = (id: string) => run(repo.tree.purge([id]), () => undefined);

  return {
    // dialogs and inline states
    creating,
    draft,
    setDraft,
    renamingId,
    setRenamingId,
    movingId,
    setMovingId,
    deleting,
    setDeleting,
    trashOpen,
    setTrashOpen,
    paletteOpen,
    setPaletteOpen,
    // actions
    startCreating,
    cancelCreating,
    createNotebook,
    addChild,
    addPage,
    rename,
    move,
    reorder,
    trash,
    requestDelete,
    restore,
    deleteForever,
  };
}

export type TreeActions = ReturnType<typeof useTreeActions>;
