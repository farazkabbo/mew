import {
  fromNodeSync,
  type Notebook,
  type NotebookNodeSync,
  type NotebookTreeSyncResult,
} from "@mew/shared";

/**
 * How the device's tree and the server's meet (K1, docs/NOTEBOOKS_K.md decision 0.1 #6). Pure:
 * the repository reads the rows, asks this what to do, and writes the answer in one transaction.
 *
 * - The device is the source of truth for the student's edits: a node with changes still to
 *   send is never overwritten by the server's copy.
 * - The latest edit wins (`editedAt`), so a node changed on another device later replaces this
 *   one's older copy.
 * - Every surprise is told, never silent: a name numbered because it was taken, a move refused.
 */

/** Something the student is told after a sync. */
export type TreeNotice =
  | { kind: "renamed"; from: string; to: string }
  | { kind: "moved_back"; title: string }
  | { kind: "not_saved"; title: string };

/** What to do after the server answered a push. */
export type ResultPlan = {
  /** Nodes to store as the server has them (renamed, refused, or edited later elsewhere). */
  adopt: Notebook[];
  /** Outbox entries that are done. */
  done: string[];
  /** Nodes the server refused without a copy of its own: tried again later, a few times. */
  retry: string[];
  notices: TreeNotice[];
};

/**
 * The server's answers for the nodes sent. A node changed again while the push was on its way
 * is left queued, whatever the answer: its newer state goes next time.
 */
export function planResults(
  sent: readonly NotebookNodeSync[],
  { results }: NotebookTreeSyncResult,
  local: ReadonlyMap<string, Notebook>,
  now: number,
): ResultPlan {
  const plan: ResultPlan = { adopt: [], done: [], retry: [], notices: [] };
  const sentById = new Map(sent.map((n) => [n.id, n]));
  for (const { id, status, node } of results) {
    const mine = local.get(id);
    const asSent = sentById.get(id);
    if (!asSent) continue;
    if (mine && mine.editedAt > asSent.editedAt) continue; // edited meanwhile: send again

    if (status === "saved") {
      plan.done.push(id);
    } else if (node) {
      plan.adopt.push(fromNodeSync(node, mine, now));
      plan.done.push(id);
      if (status === "renamed") {
        plan.notices.push({ kind: "renamed", from: asSent.title, to: node.title });
      } else if (status === "rejected" && node.parentId !== asSent.parentId) {
        plan.notices.push({ kind: "moved_back", title: node.title });
      }
    } else if (status === "rejected") {
      plan.retry.push(id);
    } else {
      plan.done.push(id); // "stale" without a copy can't happen; nothing to adopt
    }
  }
  return plan;
}

/** What to do with the server's whole tree (pulled on start, on focus, now and then). */
export type PullPlan = {
  /** Nodes to store: new from another device, or edited there later. */
  put: Notebook[];
  /** Local nodes the server doesn't have (it lost them, or never got them): sent again. */
  requeue: string[];
};

export function planPull(
  local: readonly Notebook[],
  server: readonly NotebookNodeSync[],
  queued: ReadonlySet<string>,
  now: number,
): PullPlan {
  const plan: PullPlan = { put: [], requeue: [] };
  const mine = new Map(local.map((n) => [n.id, n]));
  const theirs = new Set(server.map((n) => n.id));
  for (const node of server) {
    if (queued.has(node.id)) continue; // a change (or a purge) of ours is on its way
    const existing = mine.get(node.id);
    if (!existing || node.editedAt > existing.editedAt) {
      plan.put.push(fromNodeSync(node, existing, now));
    }
  }
  for (const node of local) {
    if (!theirs.has(node.id) && !queued.has(node.id)) plan.requeue.push(node.id);
  }
  return plan;
}

/** The sentence shown for a notice. */
export function noticeText(notice: TreeNotice): string {
  switch (notice.kind) {
    case "renamed":
      return `You already had “${notice.from}” there, so it's now “${notice.to}”.`;
    case "moved_back":
      return `“${notice.title}” couldn't move there, so it's back where it was.`;
    case "not_saved":
      return `“${notice.title}” couldn't be saved to your account. It's still on this device.`;
  }
}
