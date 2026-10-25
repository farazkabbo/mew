import "fake-indexeddb/auto";

import type { NotebookTreeSyncResult } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotebookDb } from "./db";
import { NotebookRepository } from "./repository";
import type { PendingTree, TreeRepository } from "./tree-repository";
import { TreeSync, type TreeSyncDeps } from "./tree-sync";
import type { TreeNotice } from "./tree-sync-plan";

let tree: TreeRepository;
let users = 0;

beforeEach(() => {
  tree = new NotebookRepository(new NotebookDb(`sync_${++users}`)).tree;
});

/** A server that saves everything it's sent, counting calls. */
function savingServer() {
  const pushes: PendingTree[] = [];
  const push = vi.fn(async (body: PendingTree): Promise<NotebookTreeSyncResult> => {
    pushes.push(body);
    return { results: body.nodes.map((n) => ({ id: n.id, status: "saved", node: n })) };
  });
  return { pushes, push };
}

function sync(overrides: Partial<TreeSyncDeps>) {
  const notices: TreeNotice[] = [];
  const deps: TreeSyncDeps = {
    repo: tree,
    push: async () => null,
    pull: async () => [],
    notify: (n) => notices.push(n),
    online: () => true,
    ...overrides,
  };
  return { sync: new TreeSync(deps), notices };
}

describe("TreeSync", () => {
  it("pushes what's queued until nothing is left", async () => {
    await tree.createNotebook({ title: "Physics", chapters: ["A", "B"] });
    const server = savingServer();
    await sync({ push: server.push }).sync.run({ pull: false });
    expect(server.pushes).toHaveLength(1);
    expect(server.pushes[0]?.nodes.map((n) => n.title)).toEqual(["Physics", "A", "B"]);
    expect((await tree.pending()).nodes).toEqual([]);
  });

  it("keeps everything queued when offline or when the push fails", async () => {
    await tree.createNotebook({ title: "Physics" });
    const offline = savingServer();
    await sync({ push: offline.push, online: () => false }).sync.run({ pull: true });
    expect(offline.push).not.toHaveBeenCalled();
    await sync({ push: async () => null }).sync.run({ pull: false });
    expect((await tree.pending()).nodes).toHaveLength(1);
  });

  it("tells the student about a numbered name", async () => {
    const physics = await tree.createNotebook({ title: "Physics" });
    const { sync: running, notices } = sync({
      push: async (body) => ({
        results: body.nodes.map((n) => ({
          id: n.id,
          status: "renamed",
          node: { ...n, title: "Physics 2" },
        })),
      }),
    });
    await running.run({ pull: false });
    expect(notices).toEqual([{ kind: "renamed", from: "Physics", to: "Physics 2" }]);
    expect((await tree.tree()).get(physics.id)?.title).toBe("Physics 2");
  });

  it("pulls the server's tree when asked", async () => {
    const pull = vi.fn(async () => []);
    await sync({ pull }).sync.run({ pull: true });
    expect(pull).toHaveBeenCalledOnce();
  });

  it("folds requests made during a run into one more run", async () => {
    await tree.createNotebook({ title: "Physics" });
    const server = savingServer();
    const { sync: running } = sync({ push: server.push });
    const first = running.run({ pull: false });
    void running.run({ pull: false });
    void running.run({ pull: false });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await running.run({ pull: false }); // waits for the follow-up
    expect(server.push).toHaveBeenCalledTimes(1); // the follow-up found nothing left
  });
});
