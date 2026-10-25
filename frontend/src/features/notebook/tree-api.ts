import {
  type NotebookNodeSync,
  type NotebookTreeSync,
  NotebookTreeSyncResult,
  NotebookTreeView,
} from "@mew/shared";

type Fetch = typeof fetch;
const defaultFetch: Fetch = (...args) => fetch(...args);

/** Sends the device's tree changes. Null when it didn't get through (offline, refused, down). */
export async function pushTree(
  body: NotebookTreeSync,
  fetchImpl: Fetch = defaultFetch,
): Promise<NotebookTreeSyncResult | null> {
  try {
    const response = await fetchImpl("/api/notebooks/tree", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const parsed = NotebookTreeSyncResult.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The server's copy of the tree. Null when it didn't come (offline, refused, down). */
export async function pullTree(
  fetchImpl: Fetch = defaultFetch,
): Promise<NotebookNodeSync[] | null> {
  try {
    const response = await fetchImpl("/api/notebooks/tree", {
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const parsed = NotebookTreeView.safeParse(await response.json());
    return parsed.success ? parsed.data.nodes : null;
  } catch {
    return null;
  }
}
