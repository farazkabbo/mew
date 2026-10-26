import type { Line, PageDocument } from "@mew/ink";
import {
  type BoardAction,
  type ImageBlock,
  type LineCheck,
  type QuizContext,
  reconcileMarks,
  TTS_SAMPLE_RATE,
  type TutorRequest,
} from "@mew/shared";

import type { WorkChecker } from "../check/checker";
import { useVoice } from "../voice/store";
import { buildTutorRequest } from "./context";
import { isLikelyEcho, newWords } from "./echo";
import type { PcmStreamPlayer } from "./pcm-player";
import type { TutorInk } from "./ink";
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
  /** Writes board actions as ink (absent in tests that only cover speech). */
  ink?: Pick<TutorInk, "render" | "pause" | "finish">;
  /** Verifies work for check_work turns (absent in tests that only cover speech). */
  checker?: Pick<WorkChecker, "check">;
  /** The course of the notebook on screen, if any (its passages go to the tutor). */
  courseId?: () => string | null;
  /** The quiz question being answered, if a quiz is running. */
  quiz?: () => QuizContext | null;
  /** The student's chosen voice (null: the server's default). */
  voiceId?: () => string | null;
  /** The page on screen, if any. */
  doc(): PageDocument | null;
  /** Images on that page (clips saved from the screen). */
  images?: () => readonly ImageBlock[];
  /** Lines the student just circled (K6 §6.3), taken by the turn about them; null if none. */
  takeCircled?: () => readonly Line[] | null;
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
  /** Verdicts already found (e.g. by the quiet check after a writing pause). */
  checks?: LineCheck[] | undefined;
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

  async respond(input: RespondInput): Promise<void> {
    const { intent, utterance, triggeredAt, gateMs } = input;
    this.deps.ink?.finish(); // the previous turn's ink lands in full before new ink starts
    this.interrupt();
    const tutor = useTutor.getState();
    const id = tutor.begin({ intent, utterance, at: triggeredAt, gateMs });
    const turn: ActiveTurn = { id, abort: new AbortController(), speech: "" };
    this.active = turn;
    tutor.setCaption(null);

    let outcome: Turn["outcome"] = "done";
    let speaking: Promise<void> = Promise.resolve();
    let checks: LineCheck[] = input.checks ?? [];
    let drew = false;
    try {
      if (intent === "check_work" && !input.checks && this.deps.checker) {
        const doc = this.deps.doc();
        checks = doc ? await this.deps.checker.check(doc) : [];
      }
      if (checks.length > 0) useTutor.getState().update(id, { checks });
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
        images: this.deps.images?.() ?? [],
        recognition: this.deps.recognition,
        courseId: this.deps.courseId?.() ?? null,
        quiz: this.deps.quiz?.() ?? null,
        circled: this.deps.takeCircled?.() ?? null,
      });
      request.checks = checks;
      for await (const event of streamTutor(request, turn.abort.signal)) {
        if (event.type === "speech") {
          turn.speech = event.text;
          useTutor
            .getState()
            .update(id, { speech: event.text }, { tutorSpeechMs: this.since(triggeredAt) });
          useTutor.getState().setCaption(event.text);
          speaking = this.speak(turn, triggeredAt);
        } else if (event.type === "response") {
          // Verifiers outrank the model: marks are made to agree with them.
          drew = this.draw(id, reconcileMarks(event.response.actions, checks), turn, triggeredAt);
        } else {
          outcome = "failed";
          this.fallBack(id, checks, turn, triggeredAt, drew, event.message);
        }
      }
      await speaking;
    } catch {
      outcome = "failed";
      if (!turn.abort.signal.aborted) this.fallBack(id, checks, turn, triggeredAt, drew);
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

  private draw(id: number, actions: BoardAction[], turn: ActiveTurn, triggeredAt: number): boolean {
    useTutor.getState().update(id, { actions });
    const rendering = this.deps.ink?.render(actions, {
      speech: turn.speech,
      onStart: () => useTutor.getState().update(id, {}, { inkStartMs: this.since(triggeredAt) }),
    });
    // Planning may take a moment (graph layout); record what was drawn once it's known.
    void rendering?.then((ink) => useTutor.getState().update(id, { ink })).catch(() => undefined);
    return true;
  }

  /**
   * The model couldn't answer. If a verifier already knows the line is wrong (or right), the
   * page still says so; otherwise a short apology.
   */
  private fallBack(
    id: number,
    checks: readonly LineCheck[],
    turn: ActiveTurn,
    triggeredAt: number,
    drew: boolean,
    /** The server's explanation (e.g. the model is busy), if it gave one. */
    reason?: string,
  ): void {
    const marks = reconcileMarks([], checks);
    const wrong = checks.some((c) => c.target && c.verdict === "incorrect");
    if (marks.length > 0 && !drew) this.draw(id, marks, turn, triggeredAt);
    useTutor
      .getState()
      .setCaption(
        marks.length === 0
          ? reason || "I couldn't answer just now — try again in a moment."
          : wrong
            ? "Something's off in that step — have another look."
            : "That step checks out.",
      );
  }

  /**
   * Says a prepared line (a quiz question, a hint, a grade) without a model call: caption plus
   * voice, interruptible like any turn. Resolves when it has been said (or cut off).
   */
  async announce(text: string): Promise<void> {
    this.interrupt();
    const turn: ActiveTurn = { id: 0, abort: new AbortController(), speech: text };
    this.active = turn;
    const tutor = useTutor.getState();
    tutor.setCaption(text);
    try {
      await this.speak(turn, this.now());
    } finally {
      if (this.active === turn) {
        this.active = null;
        this.lastSpoken = { text, endedAt: this.now() };
        useTutor.setState({ phase: "idle", lastFinishedAt: Date.now() });
        this.deps.onFinished();
      }
    }
  }

  /** A partial transcript arrived: barge in if it's the student, not our own voice. */
  heard(partial: string): void {
    const turn = this.active;
    const said = turn?.speech ?? this.lastSpoken?.text ?? "";
    if (newWords(partial, said) < BARGE_IN_WORDS) return;
    this.deps.ink?.pause();
    if (turn && useTutor.getState().phase === "speaking") this.interrupt();
  }

  /** The student put the pen down: stop talking (and writing) over them. */
  writing(): void {
    this.deps.ink?.pause();
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
        body: JSON.stringify({ text: turn.speech, voiceId: this.deps.voiceId?.() ?? null }),
        cache: "no-store",
        signal: turn.abort.signal,
      });
      if (!response.ok || !response.body) {
        // No voice: the caption still shows the reply. Say why (e.g. a paid-only voice).
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        if (typeof body?.error === "string") useTutor.getState().setVoiceIssue(body.error);
        return;
      }
      useTutor.getState().setVoiceIssue(null);
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
