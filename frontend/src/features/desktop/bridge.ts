import { ReviewQueue } from "@mew/shared";

/**
 * The desktop app (Tauri, desktop/) shows this web app in its own window. Inside it, the page may
 * call three commands, each checked in Rust:
 * - `notify_due`: show a review reminder;
 * - `screen_coach_ask`: ask Screen Coach about the frame the desktop app captured on the hotkey
 *   (the page sends only the words; it never sees the screenshot);
 * - `screen_coach_link_finish`: hand the desktop app a one-time sign-in code.
 * The desktop app's Ctrl+Shift+M hotkey arrives as a `mew:summon` event.
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

/** Asks Screen Coach about the captured screen. The answer arrives as `mew:screen-*` events. */
export async function askAboutScreen(transcript: string): Promise<void> {
  await invoke("screen_coach_ask", { transcript });
}

/** Gives the desktop app the one-time code for the sign-in it started (it redeems it). */
export async function finishDeviceLink(code: string): Promise<void> {
  const result = invoke("screen_coach_link_finish", { code });
  if (!result) throw new Error("Not running in the Mew desktop app");
  await result;
}
