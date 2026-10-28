"use client";

import { Bug, Mic, MicOff, VolumeX, X } from "lucide-react";
import Link from "next/link";

import { NebDot, nebDotLabel, type NebDotState } from "@/components/ui/NebDot";

import { Caption } from "../tutor/Caption";
import { useTutor } from "../tutor/store";
import { useVoice } from "../voice/store";
import { useMew } from "./store";
import { type MascotState, useMascotState } from "./useMewSession";

/** The session's state as the neb dot shows it (NEB_APP_UI §3.8). */
const DOT: Record<MascotState, NebDotState> = {
  sleeping: "watching",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
  muted: "off",
};

type Props = {
  onSummon(): void;
  onStartListening(): void;
  onStopListening(): void;
};

/** Bottom-right controls: debug toggle, microphone toggle, and the neb dot (tap to ask neb). */
export function MewDock({ onSummon, onStartListening, onStopListening }: Props) {
  const state = useMascotState();
  const { status, error, level } = useVoice();
  const { debugOpen, toggleDebug } = useMew();
  const voiceIssue = useTutor((s) => s.voiceIssue);
  const listening = status === "listening" || status === "connecting";

  const small =
    "grid size-9 place-items-center rounded-full border border-line bg-paper-hi/95 text-muted shadow-sm backdrop-blur hover:text-ink";

  return (
    <div className="pointer-events-auto flex flex-col items-end gap-2">
      <Caption />
      {status === "error" && error && (
        <p
          role="alert"
          className="max-w-64 rounded-xl bg-ink px-3 py-2 text-xs text-paper shadow-lg"
        >
          {error}
        </p>
      )}
      {voiceIssue && (
        <div
          data-testid="voice-issue"
          className="flex max-w-72 items-start gap-2 rounded-xl border border-line bg-paper-hi px-3 py-2 text-xs shadow-lg"
        >
          <VolumeX className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <p className="min-w-0 flex-1">
            {voiceIssue}{" "}
            <Link href="/settings" className="text-ink underline-offset-2 hover:underline">
              Settings
            </Link>
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => useTutor.getState().setVoiceIssue(null)}
            className="text-muted hover:text-ink"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          className={`${small} aria-pressed:bg-ink aria-pressed:text-paper`}
          aria-label="Debug panel"
          title="Debug panel"
          aria-pressed={debugOpen}
          onClick={toggleDebug}
        >
          <Bug className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          className={small}
          aria-label={listening ? "Stop listening" : "Start listening"}
          title={listening ? "Stop listening" : "Start listening"}
          onClick={listening ? onStopListening : onStartListening}
        >
          {listening ? (
            <Mic className="size-4 text-ink" aria-hidden />
          ) : (
            <MicOff className="size-4" aria-hidden />
          )}
        </button>
        <button
          type="button"
          onClick={onSummon}
          aria-label={`Ask neb. ${nebDotLabel(DOT[state])}.`}
          title="Ask neb (or say “Hey Neb”)"
          data-mascot-state={state}
          className="grid size-14 place-items-center rounded-full bg-paper-hi shadow-sh-2 transition-transform duration-[120ms] hover:scale-105 active:scale-95"
        >
          <NebDot state={DOT[state]} level={level} size={36} />
        </button>
      </div>
    </div>
  );
}
