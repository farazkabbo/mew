"use client";

import { currentLine } from "@mew/ink";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PageEngine } from "../notebook/engine";
import { studentLines } from "../notebook/export-line";
import { TutorController } from "../tutor/controller";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import { RecognitionService } from "../tutor/recognition";
import { useTutor } from "../tutor/store";
import { useVoice } from "../voice/store";
import { VoiceSession } from "../voice/voice-session";
import { MewController } from "./controller";
import { HttpMewGate } from "./gate";
import type { MascotState } from "./Mascot";
import { useMew } from "./store";
import { browserClock } from "./triggers";

/** Recognise the line being written once the pen has rested this long. */
const RECOGNIZE_AFTER_MS = 1200;
/** The tutor counts as having "spoken recently" for this long after a turn. */
const RECENT_TUTOR_MS = 10_000;

/** The voice → Mew → tutor pipeline, independent of React. */
function createPipeline() {
  let engine: PageEngine | null = null;
  let mew: MewController | null = null;
  const recognition = new RecognitionService();
  const tutor = new TutorController({
    player: new PcmStreamPlayer(),
    recognition,
    doc: () => engine?.doc ?? null,
    onFinished: () => mew?.tutorFinished(),
  });
  mew = new MewController(new HttpMewGate(), browserClock, {
    onRespond: (turn) => void tutor.respond(turn),
    tutorSpokeRecently: () => {
      const { phase, lastFinishedAt } = useTutor.getState();
      const recent = lastFinishedAt !== null && Date.now() - lastFinishedAt < RECENT_TUTOR_MS;
      return phase !== "idle" || recent;
    },
    activeRegionText: (doc) => recognition.currentLineText(doc),
  });
  const gate = mew;
  return {
    mew: gate,
    tutor,
    recognition,
    /** Follows the page on screen. */
    setEngine(next: PageEngine | null) {
      engine = next;
      gate.observe(next);
    },
  };
}

/**
 * Owns the voice → Mew → tutor pipeline for the notebook screen: listening, the gate, tutor turns
 * with spoken replies, barge-in, and background handwriting recognition.
 */
export function useMewSession(engine: PageEngine | null) {
  const [pipeline] = useState(createPipeline);
  const { mew, tutor, recognition } = pipeline;
  const voice = useRef<VoiceSession | null>(null);

  useEffect(() => {
    pipeline.setEngine(engine);
  }, [pipeline, engine]);
  useRecognitionOnPause(engine, recognition);

  useEffect(
    () => () => {
      mew.dispose();
      tutor.interrupt();
      voice.current?.stop();
    },
    [mew, tutor],
  );

  const startListening = useCallback(() => {
    tutor.unlockAudio(); // inside the click: lets the tutor's voice play later
    voice.current?.stop();
    const session = new VoiceSession({
      onUtterance: (text) => {
        if (!tutor.isEcho(text)) mew.utterance(text);
      },
      onSpeech: (partial) => {
        mew.speech();
        tutor.heard(partial);
      },
    });
    voice.current = session;
    void session.start();
  }, [mew, tutor]);

  const stopListening = useCallback(() => {
    voice.current?.stop();
    voice.current = null;
  }, []);

  /** Typed (or simulated) speech goes through the same path as spoken words. */
  const say = useCallback(
    (text: string) => {
      tutor.unlockAudio();
      useVoice.getState().commit(text);
      mew.utterance(text);
    },
    [mew, tutor],
  );

  const summon = useCallback(() => {
    tutor.unlockAudio();
    mew.summon();
  }, [mew, tutor]);

  /** The pen touched the page: don't talk over someone who's writing. */
  const penDown = useCallback(() => tutor.writing(), [tutor]);

  return { startListening, stopListening, say, summon, penDown };
}

/** Recognises the line being written after the pen rests, so Mew and the tutor know its text. */
function useRecognitionOnPause(engine: PageEngine | null, service: RecognitionService) {
  useEffect(() => {
    if (!engine) return;
    let timer: number | undefined;
    const unsubscribe = engine.subscribe((change) => {
      if (change !== "draw") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const line = currentLine(studentLines(engine.doc));
        if (line) void service.recognize(engine.doc, line);
      }, RECOGNIZE_AFTER_MS);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [engine, service]);
}

/** Derives the mascot's state from listening, gate and tutor activity. */
export function useMascotState(): MascotState {
  const status = useVoice((s) => s.status);
  const pending = useMew((s) => s.pending);
  const phase = useTutor((s) => s.phase);
  if (phase === "speaking") return "speaking";
  if (phase === "thinking" || pending > 0 || status === "connecting") return "thinking";
  if (status === "listening") return "listening";
  if (status === "muted" || status === "error") return "muted";
  return "sleeping";
}
