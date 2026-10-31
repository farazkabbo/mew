import { MomentChecksDue, ReviewQueue, SkillsView } from "@mew/shared";

/**
 * The desktop app (Tauri, desktop/) shows this web app in its own window. Inside it, the page may
 * call three commands, each checked in Rust:
 * - `notify_due`: show a review reminder;
 * - `notify_checks`: saved moments' checks are due (K8; only when the student turned it on);
 * - `notify_skills`: coach-mode skills are due for a re-check on the computer (S5);
 * - `screen_coach_onboarding`: whether Screen Coach is on, and its settings page opened (U9);
 * - `screen_coach_ask`: ask Screen Coach about the frame the desktop app captured on the hotkey
 *   (the page sends only the words; it never sees the screenshot);
 * - `screen_coach_link_finish`: hand the desktop app a one-time sign-in code;
 * - `desktop_sign_in_start`, `desktop_sign_in_ticket`, `desktop_sign_out`: signing the app in
 *   through the browser, and out;
 * - `screen_coach_spoken`: a line Screen Coach asked to be said has been said (Circle & Ask plays
 *   its steps to that timing).
 * The desktop app's summon (holding Ctrl+Alt while Screen Coach is off) arrives as a
 * `mew:summon` event.
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

/**
 * Saved moments' checks (K8 §4.7): "2 checks from things you saved are due", only when the
 * student turned these on (the desktop app shows it at most twice a day).
 */
export async function remindAboutChecks(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  now = Date.now(),
): Promise<boolean> {
  const response = await fetchImpl("/api/moments/checks", { cache: "no-store" });
  if (!response.ok) return false;
  const { checks } = MomentChecksDue.parse(await response.json());
  const due = checks.filter((c) => Date.parse(c.dueAt) <= now).length;
  if (due === 0) return false;
  return (await invoke("notify_checks", { count: due })) === true;
}

/**
 * Coach mode's skills (S5): "Time to try “Pivot tables” on your own", the most overdue first (the
 * desktop app shows it at most twice a day).
 */
export async function remindAboutSkills(
  fetchImpl: typeof fetch = (...args) => fetch(...args),
  now = Date.now(),
): Promise<boolean> {
  const response = await fetchImpl("/api/skills", { cache: "no-store" });
  if (!response.ok) return false;
  const { skills } = SkillsView.parse(await response.json());
  const due = skills
    .filter((s) => Date.parse(s.dueAt) <= now)
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
  if (due.length === 0) return false;
  const shown = await invoke("notify_skills", {
    count: due.length,
    first: due[0]?.title ?? null,
  });
  return shown === true;
}

/** Asks Screen Coach about the captured screen. The answer arrives as `mew:screen-*` events. */
export async function askAboutScreen(transcript: string): Promise<void> {
  await invoke("screen_coach_ask", { transcript });
}

/**
 * Onboarding's "Try it" (NEB_APP_UI §5.10): whether Screen Coach is on, and (`openSettings`) its
 * local settings page opened so the student can turn it on there. Null outside the desktop app
 * or if it can't say.
 */
export async function screenCoachForOnboarding(openSettings: boolean): Promise<boolean | null> {
  if (!isDesktop()) return null;
  try {
    const on = await invoke("screen_coach_onboarding", { openSettings });
    return typeof on === "boolean" ? on : null;
  } catch {
    return null;
  }
}

/** Tells the desktop app the line with `token` has been said (or couldn't be). */
export async function reportSpoken(token: number): Promise<void> {
  await invoke("screen_coach_spoken", { token });
}

/** Fired by the desktop app when the browser's answer to a sign-in couldn't be used. */
export const SIGN_IN_FAILED_EVENT = "mew:desktop-sign-in-failed";

/** Opens the website in the default browser to sign in. Returns its address, to copy. */
export async function startDesktopSignIn(): Promise<string> {
  const url = await invoke("desktop_sign_in_start", {});
  if (typeof url !== "string") throw new Error("Not running in the Neb desktop app");
  return url;
}

/** The ticket from the sign-in the browser just finished; it can only be taken once. */
export async function takeDesktopSignInTicket(): Promise<string | null> {
  const ticket = await invoke("desktop_sign_in_ticket", {});
  return typeof ticket === "string" ? ticket : null;
}

/** The window has no session, so the desktop app forgets its own sign-in too. */
export async function signOutOfDesktop(): Promise<void> {
  await invoke("desktop_sign_out", {});
}

/** Gives the desktop app the one-time code for the sign-in it started (it redeems it). */
export async function finishDeviceLink(code: string): Promise<void> {
  const result = invoke("screen_coach_link_finish", { code });
  if (!result) throw new Error("Not running in the Neb desktop app");
  await result;
}
