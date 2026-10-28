"use client";

import type { Notebook, NotebookTree, Page } from "@mew/shared";
import { useEffect, useState } from "react";

import type { NotebookRepository } from "../repository";
import type { NewNotebook } from "../tree-repository";
import { ConfirmDialog } from "./ConfirmDialog";
import { CreateNotebookDialog } from "./CreateNotebookDialog";
import { DestinationPicker } from "./DestinationPicker";
import type { Moment } from "../../moments/moments";
import { JumpPalette, type PaletteCommand } from "./JumpPalette";
import { TrashDialog } from "./TrashDialog";
import type { TreeActions } from "./useTreeActions";

type Props = {
  actions: TreeActions;
  /** K4: a new notebook started from a PDF. */
  onFromPdf?(notebook: NewNotebook): void;
  tree: NotebookTree<Notebook>;
  repo: NotebookRepository;
  now: number;
  openNode(id: string): void;
  openPage(page: Page): void;
  /** K8: saved moments, which Ctrl+K finds too. */
  moments: readonly Moment[];
  onOpenMoment(moment: Moment): void;
  /** What "> " lists in the palette (U9). */
  commands?: readonly PaletteCommand[];
};

const MOVE_REASONS = { depth: "too deep", cycle: "inside itself", missing: "gone" } as const;

/** The notebook tree's dialogs: create, move to…, delete, trash and jump (Ctrl+K). */
export function TreeDialogs({
  actions,
  tree,
  repo,
  now,
  openNode,
  openPage,
  onFromPdf,
  moments,
  onOpenMoment,
  commands,
}: Props) {
  const [pages, setPages] = useState<Page[]>([]);
  const moving = actions.movingId ? tree.get(actions.movingId) : undefined;

  // The palette lists every page: read when it opens.
  useEffect(() => {
    if (!actions.paletteOpen) return;
    let live = true;
    void repo.listAllPages().then((all) => live && setPages(all));
    return () => {
      live = false;
    };
  }, [actions.paletteOpen, repo]);

  return (
    <>
      <CreateNotebookDialog
        open={actions.creating}
        tree={tree}
        onCreate={actions.createNotebook}
        {...(onFromPdf && { onFromPdf })}
        onCancel={actions.cancelCreating}
        onDraft={actions.setDraft}
      />

      <DestinationPicker
        open={moving !== undefined}
        title={moving ? `Move “${moving.title}” to…` : "Move to…"}
        tree={tree}
        topLevel
        refuse={(destination) => {
          if (!moving) return "gone";
          if (destination === tree.parentOf(moving.id)) return "already here";
          const check = tree.canMove(moving.id, destination);
          return check.ok ? null : MOVE_REASONS[check.reason];
        }}
        onPick={(destination) => {
          if (moving) actions.move(moving.id, destination, Number.MAX_SAFE_INTEGER);
        }}
        onClose={() => actions.setMovingId(null)}
      />

      <DestinationPicker
        open={actions.movingPageId !== null}
        title="Move this page to…"
        tree={tree}
        topLevel={false}
        refuse={() => null}
        onPick={(destination) => {
          if (actions.movingPageId && destination) {
            actions.movePage(actions.movingPageId, destination);
          }
        }}
        onClose={() => actions.setMovingPageId(null)}
      />

      <ConfirmDialog
        open={actions.deleting !== null}
        title={actions.deleting?.title ?? ""}
        body={actions.deleting?.body ?? ""}
        confirm="Move to trash"
        onConfirm={() => {
          if (actions.deleting) actions.trash(actions.deleting.id);
          actions.setDeleting(null);
        }}
        onCancel={() => actions.setDeleting(null)}
      />

      <TrashDialog
        open={actions.trashOpen}
        tree={tree}
        now={now}
        onRestore={actions.restore}
        onDeleteForever={actions.deleteForever}
        onClose={() => actions.setTrashOpen(false)}
      />

      <JumpPalette
        open={actions.paletteOpen}
        tree={tree}
        pages={pages}
        onOpenNode={openNode}
        onOpenPage={openPage}
        moments={moments}
        onOpenMoment={onOpenMoment}
        {...(commands && { commands })}
        onClose={() => actions.setPaletteOpen(false)}
      />
    </>
  );
}
