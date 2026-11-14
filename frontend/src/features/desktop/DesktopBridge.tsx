"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { OPEN_NOTE_EVENT, readNoteSpot } from "../notebook/NoteSpotlight";
import { ScreenCoachBridge } from "../screen/ScreenCoachBridge";
import { useSettings } from "../settings/store";
import {
  isDesktop,
  remindAboutChecks,
  remindAboutReviews,
  remindAboutSkills,
  SUMMON_EVENT,
} from "./bridge";

/** First check shortly after opening, then every half hour (the app shows at most one per 30 min). */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 30 * 60_000;

/**
 * Desktop-only behaviour, mounted on every app page: review reminders, sending the summon hotkey
 * to the notebook (which handles the event itself) from any other page, and Screen Coach's voice.
 */
export function DesktopBridge() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!isDesktop()) return;
    const check = () => {
      void remindAboutReviews().catch(() => undefined);
      void remindAboutSkills().catch(() => undefined);
      if (useSettings.getState().settings.notify_moment_checks)
        void remindAboutChecks().catch(() => undefined);
    };
    const first = window.setTimeout(check, FIRST_CHECK_MS);
    const every = window.setInterval(check, CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  useEffect(() => {
    if (!isDesktop() || pathname === "/notebook") return;
    const toNotebook = () => router.push("/notebook?summon=1");
    window.addEventListener(SUMMON_EVENT, toNotebook);
    return () => window.removeEventListener(SUMMON_EVENT, toNotebook);
  }, [pathname, router]);

  // "Do it for me" on screen: their own notes open at the line (the notebook takes it from here).
  useEffect(() => {
    if (!isDesktop() || pathname === "/notebook") return;
    const toNote = (event: Event) => {
      const spot = readNoteSpot((event as CustomEvent<unknown>).detail);
      if (spot) router.push(`/notebook?page=${spot.pageId}&spot=${spot.bbox.join(",")}`);
    };
    window.addEventListener(OPEN_NOTE_EVENT, toNote);
    return () => window.removeEventListener(OPEN_NOTE_EVENT, toNote);
  }, [pathname, router]);

  return <ScreenCoachBridge />;
}
