"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

import type { PageEngine } from "../notebook/engine";
import { useVoice } from "../voice/store";
import { VoiceSession } from "../voice/voice-session";
import { MewController } from "./controller";
import { HttpMewGate } from "./gate";
import type { MascotState } from "./Mascot";
import { useMew } from "./store";
import { browserClock } from "./triggers";

/** Owns Mew for the notebook screen: the gate controller and the listening session. */
export function useMewSession(engine: PageEngine | null) {
  const controller = useMemo(() => new MewController(new HttpMewGate(), browserClock), []);
  const voice = useRef<VoiceSession | null>(null);

  useEffect(() => {
    controller.observe(engine);
  }, [controller, engine]);

  useEffect(
    () => () => {
      controller.dispose();
      voice.current?.stop();
    },
    [controller],
  );

  const startListening = useCallback(() => {
    voice.current?.stop();
    const session = new VoiceSession({
      onUtterance: (text) => controller.utterance(text),
      onSpeech: () => controller.speech(),
    });
    voice.current = session;
    void session.start();
  }, [controller]);

  const stopListening = useCallback(() => {
    voice.current?.stop();
    voice.current = null;
  }, []);

  return { controller, startListening, stopListening };
}

/** Derives the mascot's state from listening status and gate activity. */
export function useMascotState(): MascotState {
  const status = useVoice((s) => s.status);
  const pending = useMew((s) => s.pending);
  if (pending > 0 || status === "connecting") return "thinking";
  if (status === "listening") return "listening";
  if (status === "muted" || status === "error") return "muted";
  return "sleeping";
}
