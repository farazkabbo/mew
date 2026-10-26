import {
  type Notebook,
  type NotebookTree,
  parseNotebookCommand,
  resolveDestination,
  singular,
  splitDestination,
} from "@mew/shared";

/**
 * What the notebook does with Mew's notebook labels (K3 §4.5), decided without side effects so it
 * can be tested: "save it to Physics chapter 5" moves the page on screen there; "rename this
 * chapter to Optics", "make a new notebook called Biology" and "move this chapter to Physics II"
 * change the tree. Everything is undoable, nothing is made without the student's words or tap,
 * and voice never deletes.
 */
export type VoicePlan =
  | { kind: "move_page"; pageId: string; nodeId: string; path: string[] }
  /** Not clear where: the picker opens (with the candidates the resolver found, if any). */
  | { kind: "pick_page"; pageId: string }
  /** "There's no Chapter 5 in Physics yet": offered, never done without the tap. */
  | { kind: "offer_create"; pageId: string; parentId: string; title: string; path: string[] }
  | { kind: "rename"; nodeId: string; title: string }
  | { kind: "create_notebook"; title: string }
  | { kind: "create_child"; parentId: string; title: string }
  | { kind: "move_node"; nodeId: string; parentId: string; path: string[] }
  | { kind: "pick_node"; nodeId: string }
  | { kind: "say"; text: string };

export type VoiceContext = {
  tree: NotebookTree<Notebook>;
  nodes: readonly Notebook[];
  /** The node open, and the page on screen (null on a node's home). */
  nodeId: string | null;
  pageId: string | null;
};

const NOT_HERE = "Open a page first, then tell me where it goes.";

export function planVoice(
  label: "save_to_notebook" | "notebook_command",
  utterance: string,
  destinationPhrase: string | undefined,
  context: VoiceContext,
): VoicePlan {
  const { tree, nodes, nodeId, pageId } = context;
  if (label === "save_to_notebook") {
    const phrase = destinationPhrase ?? splitDestination(utterance)?.phrase;
    if (!pageId) return { kind: "say", text: NOT_HERE };
    if (!phrase) return { kind: "pick_page", pageId };
    const result = resolveDestination(phrase, nodes, { currentNodeId: nodeId });
    switch (result.kind) {
      case "resolved":
        if (result.destination.nodeId === nodeId) {
          return {
            kind: "say",
            text: `This page is already in ${result.destination.path.join(" › ")}.`,
          };
        }
        return {
          kind: "move_page",
          pageId,
          nodeId: result.destination.nodeId,
          path: result.destination.path,
        };
      case "missing":
        return {
          kind: "offer_create",
          pageId,
          parentId: result.parentId,
          title: result.title,
          path: result.parentPath,
        };
      default:
        return { kind: "pick_page", pageId };
    }
  }

  const command = parseNotebookCommand(utterance);
  if (!command) {
    return { kind: "say", text: "I didn't catch that. Try “rename this chapter to Optics”." };
  }
  switch (command.kind) {
    case "delete_refused":
      return {
        kind: "say",
        text: "I never delete by voice. Use the ⋯ menu beside it if you're sure.",
      };
    case "rename":
      if (!nodeId) return { kind: "say", text: "Open the notebook or chapter to rename first." };
      return { kind: "rename", nodeId, title: command.title };
    case "create": {
      if (command.level === "notebook") return { kind: "create_notebook", title: command.title };
      const parentId = command.parentPhrase
        ? resolvedNode(command.parentPhrase, context)
        : nodeId && tree.depth(nodeId) < 2
          ? nodeId
          : nodeId
            ? tree.parentOf(nodeId)
            : null;
      if (!parentId) return { kind: "say", text: "Which notebook should it go in?" };
      return { kind: "create_child", parentId, title: command.title };
    }
    case "move": {
      if (!nodeId) return { kind: "say", text: "Open the chapter to move first." };
      const target = resolvedNode(command.phrase, context);
      if (!target) return { kind: "pick_node", nodeId };
      const check = tree.canMove(nodeId, target);
      if (!check.ok) {
        return {
          kind: "say",
          text:
            check.reason === "depth"
              ? "That would make more than three levels."
              : "It can't go there.",
        };
      }
      return {
        kind: "move_node",
        nodeId,
        parentId: target,
        path: tree.path(target).map((n) => n.title),
      };
    }
  }
}

/** The node a phrase clearly names, or null. */
function resolvedNode(phrase: string, { nodes, nodeId }: VoiceContext): string | null {
  const result = resolveDestination(phrase, nodes, { currentNodeId: nodeId });
  return result.kind === "resolved" ? result.destination.nodeId : null;
}

/** "a chapter", "a unit": what one child of `parentId` is called. */
export function childWord(tree: NotebookTree<Notebook>, parentId: string): string {
  const label = tree.get(parentId)?.childLabel ?? "Chapters";
  return singular(label).toLowerCase();
}
