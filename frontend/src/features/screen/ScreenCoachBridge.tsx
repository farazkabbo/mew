"use client";

import { NotesCheckResult } from "@mew/shared";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { isDesktop } from "../desktop/bridge";
import { useNotesCheck } from "../notes/check-store";
import {
  OPEN_CLIP_EVENT,
  SCREEN_EVENTS,
  ScreenAnswerDetail,
  ScreenClipSavedDetail,
  ScreenNotesOpenDetail,
  ScreenSpeechDetail,
} from "./events";
import { ScreenCoachVoice } from "./screen-coach";

/**
 * Connects the desktop app's Screen Coach events to this page (desktop only): its voice, saved
 * clips, and Notes Check's findings (the notebook marks its lines).
 */
export function ScreenCoachBridge() {
  const router = useRouter();
  useEffect(() => {
    if (!isDesktop()) return;
    const coach = new ScreenCoachVoice();
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
