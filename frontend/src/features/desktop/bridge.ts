import { ReviewQueue } from "@mew/shared";

/**
 * The desktop app (Tauri, desktop/) shows this web app in its own window. Inside it, the page can
 * ask Windows to show a review reminder (`notify_due`, the one command it may call), and the
 * desktop app's Ctrl+Shift+M hotkey arrives as a `mew:summon` event.
 */

type TauriGlobal = { core?: { invoke?: (cmd: string, args?: object) => Promise<unknown> } };

export const SUMMON_EVENT = "mew:summon";

/** True inside the desktop app (Tauri injects its IPC bridge into every page it shows). */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function invoke(command: string, args: object): Promise<unknown> | null {
  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
  return tauri?.core?.invoke?.(command, args) ?? null;
}

/** Asks Windows to show "N concepts are ready for review" (the desktop app rate-limits it). */
export async function remindAboutReviews(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<boolean> {
  const response = await fetchImpl("/api/review", { cache: "no-store" });
  if (!response.ok) return false;
  const { items } = ReviewQueue.parse(await response.json());
  if (items.length === 0) return false;
  const shown = await invoke("notify_due", {
    count: items.length,
    first: items[0]?.conceptTitle ?? null,
  });
  return shown === true;
}
