"use client";

import { Bug, Mic, MicOff } from "lucide-react";

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
  const listening = status === "listening" || status === "connecting";

  const small =
    "grid size-9 place-items-center rounded-full border border-rule bg-paper-raised/95 text-ink-muted shadow-sm backdrop-blur hover:text-ink";

  return (
    <div className="pointer-events-auto flex flex-col items-end gap-2">
      {status === "error" && error && (
        <p
          role="alert"
          className="max-w-64 rounded-xl bg-ink px-3 py-2 text-xs text-paper shadow-lg"
        >
          {error}
        </p>
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
