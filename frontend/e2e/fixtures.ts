import { DEFAULT_SETTINGS } from "@mew/shared";
import { type APIResponse, test as base } from "@playwright/test";

export * from "@playwright/test";

/**
 * Every test starts from the default settings with the first-run introduction already seen.
 * Settings live in the API service's (local mode) profile, which all tests in a run share, so
 * this also stops one test's settings from leaking into the next. Tests of the introduction
 * reset `onboarded` themselves (and "Shortcuts got simpler", K2, is marked read).
 */
export const test = base.extend<{ freshSettings: void; freshNotebooks: void }>({
  freshSettings: [
    async ({ request, baseURL }, use) => {
      const origin = new URL(baseURL ?? "http://localhost:3000").origin;
      const response = await request.patch(`${origin}/api/settings`, {
        data: { ...DEFAULT_SETTINGS, onboarded: true, shortcuts_notice_seen: true },
        headers: { origin },
      });
      if (!response.ok()) throw new Error(`resetting settings failed: ${response.status()}`);
      await use();
    },
    { auto: true },
  ],
  /**
   * The account's notebook tree starts empty too (a fresh browser takes the account's notebooks
   * when it has none, K1), so one test's notebooks never open in the next.
   */
  freshNotebooks: [
    async ({ request, baseURL }, use) => {
      const origin = new URL(baseURL ?? "http://localhost:3000").origin;
      const tree = await patiently(() => request.get(`${origin}/api/notebooks/tree`));
      if (!tree.ok()) throw new Error(`reading the notebook tree failed: ${tree.status()}`);
      const { nodes } = (await tree.json()) as { nodes: { id: string }[] };
      for (let at = 0; at < nodes.length; at += 500) {
        const removed = nodes.slice(at, at + 500).map((n) => n.id);
        const purge = await patiently(() =>
          request.put(`${origin}/api/notebooks/tree`, {
            data: { nodes: [], removed },
            headers: { origin },
          }),
        );
        if (!purge.ok()) throw new Error(`emptying the notebook tree failed: ${purge.status()}`);
      }
      await use();
    },
    { auto: true },
  ],
});

/**
 * Runs a request again after the time a 429 asks for (once): the tree's rate limit is per minute,
 * and a run of tree-heavy specs back to back can reach it with this fixture's own calls.
 */
async function patiently(send: () => Promise<APIResponse>): Promise<APIResponse> {
  const response = await send();
  if (response.status() !== 429) return response;
  const seconds = Number(response.headers()["retry-after"] ?? "5");
  await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(seconds, 1), 65) * 1000));
  return send();
}
