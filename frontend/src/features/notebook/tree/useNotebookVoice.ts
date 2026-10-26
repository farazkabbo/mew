"use client";

import type { Notebook, NotebookTree } from "@mew/shared";
import { useCallback } from "react";

import type { NotebookVoiceHandler } from "../../mew/useMewSession";
import type { NotebookRepository } from "../repository";
import type { TreeActions, TreeNoticeView } from "./useTreeActions";
import { planVoice } from "./voice-plan";

type Options = {
  repo: NotebookRepository;
  tree: NotebookTree<Notebook>;
  nodes: readonly Notebook[];
  notebookId: string | null;
  pageId: string | null;
  actions: TreeActions;
  notify(notice: TreeNoticeView): void;
  report(error: unknown): void;
  openNode(id: string): void;
};

/**
 * Carries out Mew's notebook labels (K3 §4.5; `voice-plan.ts` decides): moving the page on screen,
 * renaming, making and moving notebooks and chapters. Each one says what it did and offers Undo;
 * a missing chapter is offered ("Create it and move"), never made on its own; voice never deletes.
 */
export function useNotebookVoice({
  repo,
  tree,
  nodes,
  notebookId,
  pageId,
  actions,
  notify,
  report,
  openNode,
}: Options): NotebookVoiceHandler {
  return useCallback(
    (label, utterance, destinationPhrase) => {
      const plan = planVoice(label, utterance, destinationPhrase, {
        tree,
        nodes,
        nodeId: notebookId,
        pageId,
      });
      switch (plan.kind) {
        case "say":
          notify({ text: plan.text, tone: "info" });
          return;
        case "move_page":
          actions.movePage(plan.pageId, plan.nodeId);
          return;
        case "pick_page":
          actions.setMovingPageId(plan.pageId);
          return;
        case "offer_create":
          notify({
            text: `There's no ${plan.title} in ${plan.path.join(" › ")} yet.`,
            tone: "info",
            action: {
              label: "Create it and move",
              run: () =>
                void repo.tree
                  .addChild(plan.parentId, plan.title)
                  .then((child) => child && actions.movePage(plan.pageId, child.id))
                  .catch(report),
            },
          });
          return;
        case "rename":
          void actions.rename(plan.nodeId, plan.title).then((problem) => {
            if (problem) notify({ text: problem, tone: "error" });
          });
          return;
        case "create_notebook":
          void repo.tree
            .createNotebook({ title: plan.title })
            .then((notebook) => {
              openNode(notebook.id);
              notify({
                text: `Made the notebook “${notebook.title}”.`,
                tone: "info",
                action: { label: "Undo", run: () => actions.trash(notebook.id) },
              });
            })
            .catch(report);
          return;
        case "create_child":
          void repo.tree
            .addChild(plan.parentId, plan.title)
            .then((child) => {
              if (!child) {
                notify({
                  text: "Sections can't hold sections: three levels at most.",
                  tone: "info",
                });
                return;
              }
              openNode(child.id);
              notify({
                text: `Made “${child.title}”.`,
                tone: "info",
                action: { label: "Undo", run: () => actions.trash(child.id) },
              });
            })
            .catch(report);
          return;
        case "move_node": {
          const from = tree.parentOf(plan.nodeId);
          const index =
            from === null ? 0 : tree.children(from).findIndex((n) => n.id === plan.nodeId);
          actions.move(plan.nodeId, plan.parentId, Number.MAX_SAFE_INTEGER);
          notify({
            text: `Moved it to ${plan.path.join(" › ")}.`,
            tone: "info",
            action: {
              label: "Undo",
              run: () => actions.move(plan.nodeId, from, Math.max(0, index)),
            },
          });
          return;
        }
        case "pick_node":
          actions.setMovingId(plan.nodeId);
          return;
      }
    },
    [repo, tree, nodes, notebookId, pageId, actions, notify, report, openNode],
  );
}
