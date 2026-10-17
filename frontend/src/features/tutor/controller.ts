import type { PageDocument } from "@mew/ink";
import { TTS_SAMPLE_RATE, type TutorRequest } from "@mew/shared";

import { useVoice } from "../voice/store";
import { buildTutorRequest } from "./context";
import { isLikelyEcho, newWords } from "./echo";
import type { PcmStreamPlayer } from "./pcm-player";
import type { RecognitionService } from "./recognition";
import { type Turn, useTutor } from "./store";
import { streamTutor } from "./tutor-client";

/** Echoes can trail the end of playback by a moment (room, buffering). */
const ECHO_TAIL_MS = 3000;
/** New (non-echo) words in a partial transcript that count as the student speaking up. */
const BARGE_IN_WORDS = 2;
/** Barge-in fade (brief: within ~200 ms). */
const BARGE_IN_FADE_MS = 150;

export type TutorDeps = {
  player: PcmStreamPlayer;
  recognition: RecognitionService;
  /** The page on screen, if any. */
  doc(): PageDocument | null;
  /** Called when a turn ends, however it ends (starts Mew's cooldown). */
  onFinished(): void;
  now?: () => number;
};

type ActiveTurn = { id: number; abort: AbortController; speech: string };

export type RespondInput = {
  intent: TutorRequest["intent"];
  utterance: string;
  /** When the trigger happened (end of utterance, tap, pause), for latency accounting. */
  triggeredAt: number;
  gateMs: number;
};

/**
 * Runs tutor turns: builds context, streams the reply, speaks it, and handles barge-in — the
 * student speaking or writing over the tutor fades it out immediately.
 */
export class TutorController {
  private active: ActiveTurn | null = null;
  private lastSpoken: { text: string; endedAt: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: TutorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async respond({ intent, utterance, triggeredAt, gateMs }: RespondInput): Promise<void> {
    this.interrupt();
    const tutor = useTutor.getState();
    const id = tutor.begin({ intent, utterance, at: triggeredAt, gateMs });
    const turn: ActiveTurn = { id, abort: new AbortController(), speech: "" };
    this.active = turn;
    tutor.setCaption(null);

    let outcome: Turn["outcome"] = "done";
    let speaking: Promise<void> = Promise.resolve();
    try {
      const request = await buildTutorRequest({
        intent,
        utterance,
        transcript: useVoice.getState().segments.map((s) => s.text),
        previousSpeech: useTutor
          .getState()
          .turns.filter((t) => t.id !== id && t.speech)
          .map((t) => t.speech ?? "")
          .reverse(),
        answerStyle: useTutor.getState().answerStyle,
        doc: this.deps.doc(),
        recognition: this.deps.recognition,
      });
      for await (const event of streamTutor(request, turn.abort.signal)) {
        if (event.type === "speech") {
          turn.speech = event.text;
          useTutor
            .getState()
            .update(id, { speech: event.text }, { tutorSpeechMs: this.since(triggeredAt) });
          useTutor.getState().setCaption(event.text);
          speaking = this.speak(turn, triggeredAt);
        } else if (event.type === "response") {
          useTutor.getState().update(id, { actions: event.response.actions });
        } else {
          outcome = "failed";
          useTutor.getState().setCaption("I couldn't answer just now — try again in a moment.");
        }
      }
      await speaking;
    } catch {
      outcome = "failed";
      if (!turn.abort.signal.aborted) {
        useTutor.getState().setCaption("I couldn't answer just now — try again in a moment.");
      }
    } finally {
      if (turn.abort.signal.aborted) outcome = "interrupted";
      if (this.active === turn) this.active = null;
      if (turn.speech) this.lastSpoken = { text: turn.speech, endedAt: this.now() };
      // A newer turn may already be running (this one was superseded): leave its state alone.
      const settled = this.active === null;
      useTutor.getState().finish(id, outcome, settled);
      if (settled) this.deps.onFinished();
    }
  }

  /** A partial transcript arrived: barge in if it's the student, not our own voice. */
  heard(partial: string): void {
    const turn = this.active;
    if (!turn || useTutor.getState().phase !== "speaking") return;
    if (newWords(partial, turn.speech) >= BARGE_IN_WORDS) this.interrupt();
  }

  /** The student put the pen down: stop talking over them. */
  writing(): void {
    if (useTutor.getState().phase === "speaking") this.interrupt();
  }

  /** Stops the current turn (fetches and audio) with a short fade. */
  interrupt(): void {
    const turn = this.active;
    if (!turn) return;
    this.active = null;
    turn.abort.abort();
    this.deps.player.stop(BARGE_IN_FADE_MS);
  }

  /** Whether a finished utterance is just the tutor's speech picked up by the microphone. */
  isEcho(utterance: string): boolean {
    if (this.active?.speech && isLikelyEcho(utterance, this.active.speech)) return true;
    const last = this.lastSpoken;
    return Boolean(
      last && this.now() - last.endedAt < ECHO_TAIL_MS && isLikelyEcho(utterance, last.text),
    );
  }

  /** Unlocks audio playback; call from a user gesture. */
  unlockAudio(): void {
    this.deps.player.unlock();
  }

  private async speak(turn: ActiveTurn, triggeredAt: number): Promise<void> {
    try {
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: turn.speech }),
        cache: "no-store",
        signal: turn.abort.signal,
      });
      if (!response.ok || !response.body) return; // no voice: the caption still shows the reply
      await this.deps.player.play(response.body, {
        sampleRate: TTS_SAMPLE_RATE,
        signal: turn.abort.signal,
        onStart: () => {
          useTutor.getState().setPhase("speaking");
          useTutor.getState().update(turn.id, {}, { firstAudioMs: this.since(triggeredAt) });
        },
      });
    } catch {
      // Aborted (barge-in) or network failure: the caption remains.
    }
  }

  private since(at: number): number {
    return Math.round(this.now() - at);
  }
}
