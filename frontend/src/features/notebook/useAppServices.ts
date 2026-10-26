"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { SUMMON_EVENT } from "../desktop/bridge";
import { useSettings } from "../settings/store";
import { startLatencyReporting } from "../telemetry/reporter";

const subscribeOnline = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/**
 * What the notebook screen needs around the page itself (M9): the student's settings, latency
 * reporting, whether we're online, and starting to listen on open when they asked for that.
 */
export function useAppServices({
  ready,
  listen,
  summon,
}: {
  ready: boolean;
  listen(): void;
  summon(): void;
}) {
  const loaded = useSettings((s) => s.loaded);
  const onboarded = useSettings((s) => s.settings.onboarded);
  const listenOnOpen = useSettings((s) => s.settings.listen_on_open);
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [introClosed, setIntroClosed] = useState(false);
  const listened = useRef(false);

  useEffect(() => {
    void useSettings.getState().load();
    return startLatencyReporting();
  }, []);

  // The desktop app's summon (holding Ctrl+Alt while Screen Coach is off; here, or from another
  // page: /notebook?summon=1).
  useEffect(() => {
    if (!ready) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("summon") === "1") {
      params.delete("summon");
      const query = params.toString();
      window.history.replaceState(null, "", `/notebook${query ? `?${query}` : ""}`);
      summon();
    }
    window.addEventListener(SUMMON_EVENT, summon);
    return () => window.removeEventListener(SUMMON_EVENT, summon);
  }, [ready, summon]);

  useEffect(() => {
    if (!ready || !loaded || !listenOnOpen || !onboarded || listened.current) return;
    listened.current = true;
    listen();
  }, [ready, loaded, listenOnOpen, onboarded, listen]);

  return {
    online,
    showIntro: loaded && !onboarded && !introClosed,
    closeIntro: () => {
      setIntroClosed(true);
      // A new student learns today's shortcuts: "Shortcuts got simpler" isn't for them.
      void useSettings.getState().update({ onboarded: true, shortcuts_notice_seen: true });
    },
  };
}
