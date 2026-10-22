import {
  DEFAULT_SETTINGS,
  type SettingsPatch,
  UserSettings,
  type Voice,
  VoiceList,
} from "@mew/shared";
import { create } from "zustand";

import { useMew } from "../mew/store";
import { useTutor } from "../tutor/store";

const CACHE_KEY = "mew:settings";

type SettingsState = {
  settings: UserSettings;
  /** The server's copy has been read (or couldn't be, and the local copy stands). */
  loaded: boolean;
  /** Settings live only in this browser (the server's copy couldn't be read or saved). */
  localOnly: boolean;
  error: string | null;
  voices: Voice[];
};

type SettingsActions = {
  /** Reads the server's copy (once per page load is enough). */
  load(): Promise<void>;
  /** Changes some settings: applied at once, saved shortly after (resolves once saved). */
  update(patch: SettingsPatch): Promise<void>;
  loadVoices(): Promise<void>;
};

/**
 * The student's settings: stored in their profile (profiles.settings), cached in this browser so
 * the app starts with them, and pushed into the stores that use them (tutor, Mew).
 */
export const useSettings = create<SettingsState & SettingsActions>()((set, get) => ({
  // Defaults until load(): reading the cache here would make the first render differ from the
  // server's (a hydration mismatch).
  settings: DEFAULT_SETTINGS,
  loaded: false,
  localOnly: false,
  error: null,
  voices: [],
  load: async () => {
    const started = edits;
    if (started === 0) set({ settings: readCache() });
    try {
      const response = await fetch("/api/settings", { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      const settings = UserSettings.parse(await response.json());
      // Changes made while this was loading win (they're being saved).
      if (edits === started) {
        apply(settings);
        set({ settings });
      }
      set({ loaded: true, localOnly: false });
    } catch {
      // Offline, or settings aren't configured on the server: the local copy stands.
      apply(get().settings);
      set({ loaded: true, localOnly: true });
    }
  },
  update: (patch) => {
    edits++;
    const changes = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<UserSettings>;
    const next: UserSettings = { ...get().settings, ...changes };
    apply(next);
    set({ settings: next, error: null });
    // Coalesce quick changes (a slider being dragged) into one save.
    unsaved = { ...unsaved, ...changes };
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    savePending = () => save(set);
    return new Promise<void>((resolve) => {
      saveTimer = setTimeout(() => void save(set).then(resolve), SAVE_AFTER_MS);
    });
  },
  loadVoices: async () => {
    try {
      const response = await fetch("/api/voices", { cache: "no-store" });
      if (response.ok) set({ voices: VoiceList.parse(await response.json()).voices });
    } catch {
      // No voices to choose from; the default voice is used.
    }
  },
}));

const SAVE_AFTER_MS = 300;
/** Local changes so far; a server reply only replaces local state if none came after it. */
let edits = 0;
let unsaved: Partial<UserSettings> = {};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savePending: (() => Promise<void>) | undefined;

// Leaving the page (or hiding it) mustn't lose a change still waiting to be saved.
if (typeof window !== "undefined") {
  const flushNow = () => {
    if (saveTimer === undefined) return;
    clearTimeout(saveTimer);
    void savePending?.();
  };
  window.addEventListener("pagehide", flushNow);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushNow();
  });
}

type SetState = (state: Partial<SettingsState>) => void;

async function save(set: SetState): Promise<void> {
  const changes = unsaved;
  unsaved = {};
  saveTimer = undefined;
  const sentAt = edits;
  try {
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(changes),
      cache: "no-store",
      keepalive: true, // a change made just before leaving the page still lands
    });
    if (!response.ok) throw new Error(String(response.status));
    const saved = UserSettings.parse(await response.json());
    // A reply older than the latest change must not undo it on screen.
    if (edits === sentAt) {
      apply(saved);
      set({ settings: saved });
    }
    set({ localOnly: false, error: null });
  } catch {
    // Keep the change for this browser; say it isn't saved to the account.
    set({ localOnly: true, error: "Saved on this device only (couldn't reach your account)." });
  }
}

/** Pushes settings into the stores that act on them, and caches them in this browser. */
function apply(settings: UserSettings): void {
  useTutor.getState().setSettings({
    answerStyle: settings.answer_style,
    captions: settings.captions,
    autoCheck: settings.auto_check,
  });
  useMew.getState().setThreshold(settings.mew_threshold);
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private mode): settings last for this session.
  }
}

function readCache(): UserSettings {
  try {
    const raw = globalThis.localStorage?.getItem(CACHE_KEY);
    const parsed = UserSettings.safeParse({ ...DEFAULT_SETTINGS, ...JSON.parse(raw ?? "{}") });
    return parsed.success ? parsed.data : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}
