import type { NotebookNodeSync, NotebookTreeSyncResult } from "@mew/shared";

import type { PendingTree, TreeRepository } from "./tree-repository";
import type { TreeNotice } from "./tree-sync-plan";

export type TreeSyncDeps = {
  repo: TreeRepository;
  push(body: PendingTree): Promise<NotebookTreeSyncResult | null>;
  pull(): Promise<NotebookNodeSync[] | null>;
  notify(notice: TreeNotice): void;
  online(): boolean;
};

/** A push's worth of changes at most this many times per run (each run drains the outbox). */
const MAX_PUSHES_PER_RUN = 5;

/**
 * Keeps the server's copy of the notebook tree in step with this device (K1, Decision 14):
 * pushes queued changes (soon after an edit), and pulls the server's tree (on start, when the
 * app comes back into view, now and then) so another device's edits arrive.
 *
 * One run at a time: a request made while one runs is folded into a single follow-up run.
 */
export class TreeSync {
  private running: Promise<void> | null = null;
  private wanted: { pull: boolean } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: TreeSyncDeps) {}

  /** Syncs a moment after the last of a burst of edits. */
  schedule(delayMs = 1500): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run({ pull: false }), delayMs);
  }

  /** Pushes what's queued and, with `pull`, takes in the server's tree. */
  run({ pull }: { pull: boolean }): Promise<void> {
    if (this.running) {
      this.wanted = { pull: pull || (this.wanted?.pull ?? false) };
      return this.running;
    }
    this.running = this.once(pull).finally(() => {
      this.running = null;
      const next = this.wanted;
      this.wanted = null;
      if (next) void this.run(next);
    });
    return this.running;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  private async once(pull: boolean): Promise<void> {
    const { repo, push, notify, online } = this.deps;
    if (!online()) return;
    for (let i = 0; i < MAX_PUSHES_PER_RUN; i++) {
      const pending = await repo.pending();
      if (pending.nodes.length === 0 && pending.removed.length === 0) break;
      const result = await push(pending);
      if (!result) return; // offline or failing: the outbox keeps everything for later
      for (const notice of await repo.applyResults(pending, result)) notify(notice);
    }
    if (pull) {
      const server = await this.deps.pull();
      if (server) await repo.applyServerTree(server);
    }
  }
}
