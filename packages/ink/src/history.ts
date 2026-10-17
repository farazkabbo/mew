import type { Stroke } from "@mew/shared";

/** An undoable change to a page. Strokes are immutable values, so commands carry them whole. */
export type Command =
  { kind: "add"; strokes: readonly Stroke[] } | { kind: "erase"; strokes: readonly Stroke[] };

export function invert(command: Command): Command {
  return { kind: command.kind === "add" ? "erase" : "add", strokes: command.strokes };
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
    if (command.strokes.length === 0) return;
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
