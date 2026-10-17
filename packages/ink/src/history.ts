import type { Stroke } from "@mew/shared";

/**
 * An undoable change to a page: strokes taken off it and strokes put on it. Adding, erasing and
 * moving (remove the old version, add the new one with the same id) are all instances.
 * Strokes are immutable values, so commands carry them whole.
 */
export type Command = { readonly removed: readonly Stroke[]; readonly added: readonly Stroke[] };

export function addCommand(strokes: readonly Stroke[]): Command {
  return { removed: [], added: strokes };
}

export function eraseCommand(strokes: readonly Stroke[]): Command {
  return { removed: strokes, added: [] };
}

export function invert(command: Command): Command {
  return { removed: command.added, added: command.removed };
}

export function isEmpty(command: Command): boolean {
  return command.removed.length === 0 && command.added.length === 0;
}

/** Bounded undo/redo stacks. A new command clears the redo stack. */
export class History {
  private readonly undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(private readonly limit = 200) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  record(command: Command): void {
    if (isEmpty(command)) return;
    this.undoStack.push(command);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** The command that reverses the latest change, or undefined if there is nothing to undo. */
  undo(): Command | undefined {
    const command = this.undoStack.pop();
    if (!command) return undefined;
    this.redoStack.push(command);
    return invert(command);
  }

  /** The command that re-applies the latest undone change. */
  redo(): Command | undefined {
    const command = this.redoStack.pop();
    if (!command) return undefined;
    this.undoStack.push(command);
    return command;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack = [];
  }
}
