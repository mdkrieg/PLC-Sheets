/**
 * Generic command-pattern undo stack scoped per workbook.
 *
 * Each command captures its own redo + undo closures so the stack stays
 * agnostic of cell-edit specifics.
 */

export interface Command {
  /** Apply the change forward */
  redo: () => void;
  /** Reverse the change */
  undo: () => void;
  /** Optional human-readable label for menus/tooltips */
  label?: string;
}

export class UndoStack {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  constructor(private capacity = 200) {}

  /** Apply command and push onto the undo stack (clears redo history). */
  push(cmd: Command): void {
    cmd.redo();
    this.undoStack.push(cmd);
    if (this.undoStack.length > this.capacity) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const c = this.undoStack.pop();
    if (!c) return false;
    c.undo();
    this.redoStack.push(c);
    return true;
  }

  redo(): boolean {
    const c = this.redoStack.pop();
    if (!c) return false;
    c.redo();
    this.undoStack.push(c);
    return true;
  }

  clear(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
  }
}
