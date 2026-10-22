"use client";

import { Bug, Mic, MicOff, VolumeX, X } from "lucide-react";
import Link from "next/link";

import { Caption } from "../tutor/Caption";
import { useTutor } from "../tutor/store";
import { useVoice } from "../voice/store";
import { Mascot, mascotLabel } from "./Mascot";
import { useMew } from "./store";
import { useMascotState } from "./useMewSession";

type Props = {
  onSummon(): void;
  onStartListening(): void;
  onStopListening(): void;
};

/** Bottom-right controls: debug toggle, microphone toggle, and the mascot (tap to ask Mew). */
export function MewDock({ onSummon, onStartListening, onStopListening }: Props) {
  const state = useMascotState();
  const { status, error, level } = useVoice();
  const { debugOpen, toggleDebug } = useMew();
  const voiceIssue = useTutor((s) => s.voiceIssue);
  const listening = status === "listening" || status === "connecting";

  const small =
    "grid size-9 place-items-center rounded-full border border-rule bg-paper-raised/95 text-ink-muted shadow-sm backdrop-blur hover:text-ink";

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
          className="flex max-w-72 items-start gap-2 rounded-xl border border-rule bg-paper-raised px-3 py-2 text-xs shadow-lg"
        >
          <VolumeX className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden />
          <p className="min-w-0 flex-1">
            {voiceIssue}{" "}
            <Link href="/settings" className="text-accent underline-offset-2 hover:underline">
              Settings
            </Link>
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => useTutor.getState().setVoiceIssue(null)}
            className="text-ink-muted hover:text-ink"
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
            <Mic className="size-4 text-accent" aria-hidden />
          ) : (
            <MicOff className="size-4" aria-hidden />
          )}
        </button>
        <button
          type="button"
          onClick={onSummon}
          aria-label={`Ask Mew. ${mascotLabel(state)}.`}
          title="Ask Mew (or say “Hey Mew”)"
          data-mascot-state={state}
          className="rounded-full bg-paper-raised shadow-[0_8px_30px_-10px_rgba(0,0,0,0.35)] transition-transform hover:scale-105 active:scale-95"
        >
          <Mascot state={state} level={level} />
        </button>
      </div>
    </div>
  );
}
