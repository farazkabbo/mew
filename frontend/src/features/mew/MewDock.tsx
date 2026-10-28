"use client";

import { Bug, Mic, MicOff, VolumeX, X } from "lucide-react";
import { useEffect, useState } from "react";
import Link from "next/link";

import { Keys } from "@/components/ui/Keycap";
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
  /** "?": every shortcut and what to say instead (§5.6). */
  onShortcuts?(): void;
};

/** Bottom-right controls: debug toggle, microphone toggle, and the neb dot (tap to ask neb). */
export function MewDock({ onSummon, onStartListening, onStopListening, onShortcuts }: Props) {
  const state = useMascotState();
  const { status, error, level } = useVoice();
  const { debugOpen, toggleDebug } = useMew();
  const voiceIssue = useTutor((s) => s.voiceIssue);
  const listening = status === "listening" || status === "connecting";
  // The developer's panel: only when it's switched on on this device (`neb:debug` = "1").
  const [debugging, setDebugging] = useState(false);
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once, after hydration
      setDebugging(localStorage.getItem("neb:debug") === "1");
    } catch {
      // Storage off: no panel.
    }
  }, []);

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
      {/* The ask pill (NEB_APP_UI §4.7): what to do, and neb's mic. */}
      <div
        data-testid="ask-pill"
        className="flex h-12 items-center gap-1 rounded-full bg-paper-hi pr-1.5 pl-1 shadow-sh-2"
      >
        <button
          type="button"
          onClick={onSummon}
          aria-label={`Ask neb. ${nebDotLabel(DOT[state])}.`}
          title="Ask neb (or say “Hey Neb”)"
          data-keytip="Ctrl+Alt"
          data-mascot-state={state}
          className="flex h-10 items-center gap-2 rounded-full pr-2 pl-1 text-sm text-ink hover:bg-ink/5"
        >
          <NebDot state={DOT[state]} level={level} size={26} />
          <span className="hidden whitespace-nowrap sm:inline">
            Hold <Keys keys={["Ctrl", "Alt"]} size="sm" /> and circle anything, or just ask
          </span>
        </button>
        <button
          type="button"
          className="grid size-10 place-items-center rounded-full bg-neb text-white transition-opacity duration-[120ms] hover:opacity-90"
          aria-label={listening ? "Stop listening" : "Start listening"}
          title={listening ? "Stop listening" : "Start listening · or say “Hey Neb”"}
          onClick={listening ? onStopListening : onStartListening}
        >
          {listening ? (
            <Mic className="size-4" aria-hidden />
          ) : (
            <MicOff className="size-4" aria-hidden />
          )}
        </button>
        {onShortcuts && (
          <button
            type="button"
            className="grid size-8 place-items-center rounded-full text-sm font-semibold text-muted hover:text-ink"
            aria-label="Shortcuts and what to say"
            title="Shortcuts and what to say (Shift+?)"
            data-keytip="Shift+?"
            onClick={onShortcuts}
          >
            ?
          </button>
        )}
        {debugging && (
          <button
            type="button"
            className="grid size-8 place-items-center rounded-full text-muted hover:text-ink aria-pressed:bg-ink aria-pressed:text-paper"
            aria-label="Debug panel"
            title="Debug panel"
            aria-pressed={debugOpen}
            onClick={toggleDebug}
          >
            <Bug className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
}
