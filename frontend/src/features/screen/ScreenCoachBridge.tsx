"use client";

import { NotesCheckResult } from "@mew/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { isDesktop } from "../desktop/bridge";
import { useNotesCheck } from "../notes/check-store";
import {
  OPEN_CLIP_EVENT,
  OPEN_ENTRY_EVENT,
  SCREEN_EVENTS,
  ScreenAnswerDetail,
  ScreenClipSavedDetail,
  ScreenEntrySavedDetail,
  ScreenNotesOpenDetail,
  ScreenSayDetail,
  ScreenSpeechDetail,
} from "./events";
import { momentsApi, saveMomentAudio } from "../moments/api";
import { keepEntryVoice, SpokenLines } from "./entry-voice";
import { defaultDeps, ScreenCoachVoice } from "./screen-coach";

/**
 * Connects the desktop app's Screen Coach events to this page (desktop only): its voice (answers,
 * coach mode's lines, Circle & Ask's steps), saved clips and entries, and Notes Check's findings
 * (the notebook marks its lines).
 */
/**
 * Entries saved while the notebook wasn't open: added the next time it is (`/notebook` reads
 * them on load through `takePendingEntries`).
 */
const pendingEntries = new Set<string>();

/** How long after an entry is saved its steps' voice is uploaded (K8). */
const KEEP_VOICE_AFTER_MS = 2_000;

export function takePendingEntries(): string[] {
  const ids = [...pendingEntries];
  pendingEntries.clear();
  return ids;
}

export function ScreenCoachBridge() {
  const router = useRouter();
  useEffect(() => {
    if (!isDesktop()) return;
    // K8: each Circle & Ask step's voice, kept until its entry is saved, then uploaded with it.
    const spoken = new SpokenLines();
    const uploaded = new Set<string>();
    const coach = new ScreenCoachVoice(defaultDeps(spoken));
    const detail = (event: Event): unknown => (event as CustomEvent<unknown>).detail;

    const handlers: [string, (event: Event) => void][] = [
      [SCREEN_EVENTS.listen, () => coach.onListen()],
      [SCREEN_EVENTS.release, () => void coach.onRelease().catch(() => undefined)],
      [SCREEN_EVENTS.cancel, () => coach.onCancel()],
      [
        SCREEN_EVENTS.speech,
        (event) => {
          const speech = ScreenSpeechDetail.safeParse(detail(event));
          if (speech.success) coach.onSpeech(speech.data.text);
        },
      ],
      [
        SCREEN_EVENTS.say,
        (event) => {
          const said = ScreenSayDetail.safeParse(detail(event));
          if (said.success) coach.onSay(said.data.text, said.data.token);
        },
      ],
      [SCREEN_EVENTS.hush, () => coach.onHush()],
      [
        SCREEN_EVENTS.entrySaved,
        (event) => {
          const saved = ScreenEntrySavedDetail.safeParse(detail(event));
          if (!saved.success) return;
          // A moment later: the last step may still be arriving when the entry is saved.
          const clipId = saved.data.clipId;
          setTimeout(() => {
            void keepEntryVoice(clipId, spoken, uploaded, {
              clip: momentsApi.clip,
              upload: saveMomentAudio,
            }).catch(() => undefined); // best effort: Replay falls back to captions
          }, KEEP_VOICE_AFTER_MS);
          // The notebook adds the entry; it only comes to the front when asked (Open).
          if (window.location.pathname === "/notebook") {
            window.dispatchEvent(new CustomEvent(OPEN_ENTRY_EVENT, { detail: saved.data }));
          } else if (saved.data.open) {
            router.push(`/notebook?entry=${saved.data.clipId}`);
          } else {
            pendingEntries.add(saved.data.clipId);
          }
        },
      ],
      [
        SCREEN_EVENTS.answer,
        (event) => {
          const answer = ScreenAnswerDetail.safeParse(detail(event));
          if (answer.success) coach.onAnswer(answer.data);
        },
      ],
      [
        SCREEN_EVENTS.clipSaved,
        (event) => {
          const saved = ScreenClipSavedDetail.safeParse(detail(event));
          if (!saved.success) return;
          // The notebook builds the page; open it first if it isn't the page on screen.
          if (window.location.pathname === "/notebook") {
            window.dispatchEvent(new CustomEvent(OPEN_CLIP_EVENT, { detail: saved.data }));
          } else {
            router.push(`/notebook?clip=${saved.data.clipId}`);
          }
        },
      ],
      [
        SCREEN_EVENTS.notesChecked,
        (event) => {
          // The marks and the panel follow it in the notebook (whenever it's open).
          const result = NotesCheckResult.safeParse(detail(event));
          if (result.success) useNotesCheck.getState().show(result.data);
        },
      ],
      [
        SCREEN_EVENTS.notesOpen,
        (event) => {
          const open = ScreenNotesOpenDetail.safeParse(detail(event));
          if (!open.success) return;
          useNotesCheck.getState().focusFinding(open.data.findingId);
          if (window.location.pathname !== "/notebook") router.push("/notebook");
        },
      ],
    ];
    for (const [name, handler] of handlers) window.addEventListener(name, handler);
    return () => {
      for (const [name, handler] of handlers) window.removeEventListener(name, handler);
      coach.onCancel();
    };
  }, [router]);

  return null;
}
