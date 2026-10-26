"use client";

import { currentLine, type Line, unionBBox, type Vec } from "@mew/ink";
import {
  type AttemptSource,
  type Evidence,
  type MewDecisionResponse,
  type MewInput,
  reconcileMarks,
  TUTOR_LIMITS,
} from "@mew/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { coursesApi } from "../courses/api";
import { circledLines } from "../notebook/circle";
import type { PageEngine } from "../notebook/engine";
import { blobToBase64, renderStrokesPng, strokesOf, studentLines } from "../notebook/export-line";
import { INK_COLORS, TUTOR_HIGHLIGHT, TUTOR_INK } from "../notebook/palette";
import { WorkChecker } from "../check/checker";
import { PyodideCodeRunner } from "../check/code-runner";
import { gradeRemote } from "../quiz/grade-client";
import { QuizSession } from "../quiz/session";
import { useSettings } from "../settings/store";
import { checkMathSteps, conceptsOf, requestSolution } from "../solution/api";
import { ShowThenYou } from "../solution/flow";
import type { SolutionRecords } from "../solution/record";
import { buildTutorRequest } from "../tutor/context";
import { TutorController } from "../tutor/controller";
import { TutorInk } from "../tutor/ink";
import { pointerLeadIn } from "../tutor/NotebookPointer";
import { PcmStreamPlayer } from "../tutor/pcm-player";
import { RecognitionService } from "../tutor/recognition";
import { useTutor } from "../tutor/store";
import { useVoice } from "../voice/store";
import { VoiceSession } from "../voice/voice-session";
import { MewController, type MewHooks } from "./controller";
import { HttpMewGate } from "./gate";
import { CascadeMewGate, WorkerClassifier } from "./local-gate";
import type { MascotState } from "./Mascot";
import { useMew } from "./store";
import { browserClock } from "./triggers";

/** How long a solution waits for the problem's lines to be read. */
const READ_WAIT_MS = 4000;
/** Lines around the work that a solution request reads first. */
const PROBLEM_LINES = 6;

/** Recognise the line being written once the pen has rested this long. */
const RECOGNIZE_AFTER_MS = 1200;
/** The tutor counts as having "spoken recently" for this long after a turn. */
const RECENT_TUTOR_MS = 10_000;
/** Circled lines are what the next ask is about, if it comes this soon (K6 §6.3). */
const CIRCLED_FRESH_MS = 20_000;

/** Keeps an on-device decision for labelling (the server checks the opt-in again). */
function logLocalDecision(input: MewInput, decision: MewDecisionResponse): Promise<unknown> {
  return fetch("/api/mew/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      output: decision.output,
      source: decision.source,
      latencyMs: decision.latencyMs,
    }),
    keepalive: true,
  }).catch(() => undefined);
}

/** Mew's notebook labels (K3): handled by the notebook, never sent to the tutor. */
export type NotebookVoiceHandler = (
  label: "save_to_notebook" | "notebook_command",
  utterance: string,
  destinationPhrase: string | undefined,
) => void;

/** The voice → Mew → tutor pipeline, independent of React. */
function createPipeline() {
  let notebookVoice: NotebookVoiceHandler | null = null;
  let records: SolutionRecords | null = null;
  let engine: PageEngine | null = null;
  let courseId: string | null = null;
  let mew: MewController | null = null;
  /** Lines circled while holding Ctrl+Alt (K6 §6.3), until the turn about them takes them. */
  let circled: { lines: Line[]; at: number } | null = null;
  const takeCircled = (): Line[] | null => {
    const taken = circled;
    circled = null;
    return taken && Date.now() - taken.at <= CIRCLED_FRESH_MS ? taken.lines : null;
  };
  const recognition = new RecognitionService();
  const ink = new TutorInk({
    engine: () => engine,
    colors: () => ({
      ink: TUTOR_INK.light,
      error: INK_COLORS[2].light,
      correct: INK_COLORS[3].light,
      highlight: TUTOR_HIGHLIGHT.light,
    }),
    // The notebook's pointer glides to where the ink starts before it's written (K6 §6.3).
    leadInMs: pointerLeadIn,
  });
  const checker = new WorkChecker({ recognition, code: new PyodideCodeRunner() });
  let quiz: QuizSession | null = null;
  let solutions: ShowThenYou | null = null;
  const tutor = new TutorController({
    player: new PcmStreamPlayer(),
    recognition,
    ink,
    checker,
    courseId: () => courseId,
    quiz: () => quiz?.context() ?? null,
    voiceId: () => useSettings.getState().settings.voice_id,
    doc: () => engine?.doc ?? null,
    images: () => engine?.images ?? [],
    takeCircled,
    onFinished: () => mew?.tutorFinished(),
  });
  quiz = new QuizSession({
    api: {
      detail: (id) => coursesApi.get(id),
      progress: (id) => coursesApi.progress(id),
      lesson: (id, conceptId) => coursesApi.lesson(id, conceptId),
      attempt: (id, attempt) => coursesApi.attempt(id, attempt),
    },
    grade: (request) => gradeRemote(request),
    doc: () => engine?.doc ?? null,
    lines: studentLines,
    recognize: async (doc, line) => (await recognition.recognize(doc, line))?.text ?? null,
    renderAnswer: async (doc, lines) => {
      if (lines.length === 0) return null;
      const raster = await renderStrokesPng(
        strokesOf(doc, lines),
        lines.map((l) => l.bbox).reduce(unionBBox),
      );
      const base64 = await blobToBase64(raster.blob);
      return base64.length <= TUTOR_LIMITS.imageBase64Chars ? base64 : null;
    },
    spokenSince: (at, exclude) =>
      useVoice
        .getState()
        .segments.filter((s) => s.at >= at && s.text !== exclude && !tutor.isEcho(s.text))
        .map((s) => s.text)
        .join(" "),
    mark: (actions) => void ink.render(actions),
    say: (text) => tutor.announce(text),
    now: () => Date.now(),
  });
  const quizSession = quiz;
  // Mew v2: the on-device classifier when a model is installed and it's sure; v1 otherwise.
  const classifier = new WorkerClassifier();
  const gateV2 = new CascadeMewGate(classifier, new HttpMewGate(), {
    onLocalDecision: (input, decision) => {
      if (useSettings.getState().settings.mew_logging_opt_in)
        void logLocalDecision(input, decision);
    },
  });
  /** A turn Mew decided on, or the hold asked for: each goes where it belongs. */
  const act: NonNullable<MewHooks["onRespond"]> = (turn) => {
    if (turn.intent === "save_to_notebook" || turn.intent === "notebook_command") {
      notebookVoice?.(turn.intent, turn.utterance, turn.destinationPhrase);
      return;
    }
    const intent = turn.intent;
    if (intent === "show_full_solution" && !quizSession.active) {
      void solutions?.run(turn.utterance);
      return;
    }
    // "Is this right?" about the Your Turn is checked against its problem (K6 §6.1 step 6).
    if (intent === "check_work" && solutions?.owns(engine)) {
      void solutions.check({ quiet: false });
      return;
    }
    if (quizSession.active) {
      // "Is this right?" during a quiz is answered by the grader; asking for help counts.
      if (turn.intent === "check_work") {
        void quizSession.check(turn.utterance);
        return;
      }
      quizSession.helpedByTutor();
    }
    void tutor.respond({ ...turn, intent });
  };
  mew = new MewController(gateV2, browserClock, {
    onRespond: act,
    // A quiz is a test: no quiet ticks or remarks on pauses while the student answers.
    skip: (trigger) => trigger === "pen_pause" && quizSession.active,
    tutorSpokeRecently: () => {
      const { phase, lastFinishedAt } = useTutor.getState();
      const recent = lastFinishedAt !== null && Date.now() - lastFinishedAt < RECENT_TUTOR_MS;
      return phase !== "idle" || recent;
    },
    activeRegionText: (doc) => recognition.currentLineText(doc),
    quickCheck: (doc) => {
      if (!useTutor.getState().autoCheck) return Promise.resolve(null);
      // A pen pause in the Your Turn box checks it from its problem (and marks it itself).
      if (solutions?.owns(engine)) return solutions.check({ quiet: true }).then(() => null);
      return checker.quickCheck(doc);
    },
    // A verified-correct line just gets a small tick: no voice, no model call.
    onVerifiedCorrect: (checks) => void ink.render(reconcileMarks([], checks)),
  });
  const gate = mew;
  const read = (doc: PageEngine["doc"], line: Parameters<RecognitionService["recognize"]>[1]) =>
    Promise.race([
      recognition.recognize(doc, line),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), READ_WAIT_MS)),
    ]);
  const courseConcepts = async () => {
    if (!courseId) return [];
    return conceptsOf(await coursesApi.get(courseId));
  };
  const attempt = (conceptIds: readonly string[], evidence: Evidence, source: AttemptSource) => {
    const course = courseId;
    if (!course) return;
    for (const conceptId of conceptIds) {
      void coursesApi
        .attempt(course, { conceptId, correct: true, evidence, source })
        .catch(() => undefined);
    }
  };
  // Show-then-You (K6): "just give me the answer" is worked, verified, folded, then a Your Turn.
  solutions = new ShowThenYou({
    engine: () => engine,
    ink,
    say: (text) => (text ? tutor.announce(text) : Promise.resolve()),
    request: async (utterance) => {
      const doc = engine?.doc ?? null;
      // The problem is what the student circled (§6.1 step 1), or the lines around their work.
      const problem = takeCircled();
      if (doc) {
        // The problem's lines are read first: the model needs them as text.
        const lines =
          problem ??
          [...studentLines(doc)]
            .sort((a, b) => b.lastCreatedAt - a.lastCreatedAt)
            .slice(0, PROBLEM_LINES);
        await Promise.all(lines.map((line) => read(doc, line)));
      }
      const [context, concepts] = await Promise.all([
        buildTutorRequest({
          intent: "show_full_solution",
          utterance,
          transcript: useVoice.getState().segments.map((s) => s.text),
          previousSpeech: [],
          answerStyle: "direct",
          doc,
          images: engine?.images ?? [],
          recognition,
          courseId,
          quiz: null,
          circled: problem,
        }),
        courseConcepts().catch(() => []),
      ]);
      return {
        utterance: context.lastUtterance,
        recognizedLines: context.recognizedLines,
        pageImage: context.pageImage,
        clippedText: context.clippedText,
        courseContext: context.courseContext,
        concepts,
        variantOf: null,
      };
    },
    solve: (request) => requestSolution(request),
    checkMath: checkMathSteps,
    read: async (doc, line) => {
      const recognised = await read(doc, line);
      return recognised ? (recognised.latex ?? recognised.text).trim() || null : null;
    },
    hintTurn: (checks) =>
      void tutor.respond({
        intent: "check_work",
        utterance: "Check my work.",
        triggeredAt: Date.now(),
        gateMs: 0,
        checks,
      }),
    hintStep: () =>
      void tutor.respond({
        intent: "complete_step",
        utterance: "Give me a hint step.",
        triggeredAt: Date.now(),
        gateMs: 0,
      }),
    attempt,
    review: (conceptIds) => {
      const course = courseId;
      if (!course) return;
      for (const id of conceptIds) void coursesApi.explored(course, id).catch(() => undefined);
    },
    save: (record) => records?.save(record) ?? Promise.resolve(),
    courseId: () => courseId,
    yourTurnWanted: () => useSettings.getState().settings.your_turn_after_solution,
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  });
  const showThenYou = solutions;
  return {
    mew: gate,
    tutor,
    recognition,
    ink,
    quiz: quizSession,
    classifier,
    showThenYou,
    engine: () => engine,
    /** Where worked solutions are kept on this device (the notebook's database). */
    setRecords(next: SolutionRecords | null) {
      records = next;
    },
    /** The course of the notebook on screen (the tutor draws on its material). */
    setCourse(next: string | null) {
      courseId = next;
    },
    /** Who handles Mew's notebook labels (the notebook screen, K3). */
    setNotebookVoice(handler: NotebookVoiceHandler | null) {
      notebookVoice = handler;
    },
    /** A loop drawn while holding Ctrl+Alt: the lines in it join what the next ask is about. */
    circle(loop: readonly Vec[]) {
      if (!engine) return;
      const lines = circledLines(engine.doc, loop);
      if (lines.length === 0) return;
      const known = new Set(circled?.lines.map((l) => l.id));
      circled = {
        lines: [...(circled?.lines ?? []), ...lines.filter((l) => !known.has(l.id))],
        at: Date.now(),
      };
    },
    /** The hold started again or was cancelled: nothing circled is kept. */
    clearCircled() {
      circled = null;
    },
    /**
     * Letting go of Ctrl+Alt (K6 §6.3): words said during the hold are asked (about what was
     * circled, if anything); circling without words explains the circled lines, as an empty ask
     * bar does ("explain this", §11.2); neither is a tap on the mascot.
     */
    releaseHold(heldAt: number) {
      const { partial, segments } = useVoice.getState();
      const said = partial.trim() !== "" || segments.some((s) => s.at >= heldAt);
      if (said || !circled) {
        gate.summon();
        return;
      }
      // Through the same path as a spoken question, so a quiz counts it as help.
      act({
        intent: "answer_question",
        trigger: "summon",
        utterance: "Explain this.",
        triggeredAt: Date.now(),
        gateMs: 0,
      });
    },
    /** Follows the page on screen. */
    setEngine(next: PageEngine | null) {
      if (next !== engine) ink.finish(); // unfinished ink lands on the page it was meant for
      engine = next;
      gate.observe(next);
    },
  };
}

/**
 * Owns the voice → Mew → tutor pipeline for the notebook screen: listening, the gate, tutor turns
 * with spoken replies, barge-in, and background handwriting recognition.
 */
export function useMewSession(
  engine: PageEngine | null,
  courseId: string | null = null,
  onNotebookVoice: NotebookVoiceHandler | null = null,
) {
  const [pipeline] = useState(createPipeline);
  useEffect(() => {
    pipeline.setNotebookVoice(onNotebookVoice);
  }, [pipeline, onNotebookVoice]);
  const { mew, tutor, recognition, ink, quiz, showThenYou } = pipeline;
  const voice = useRef<VoiceSession | null>(null);

  useEffect(() => {
    pipeline.setEngine(engine);
  }, [pipeline, engine]);
  // Mew v2: start loading the on-device model, if there is one (v1 decides meanwhile).
  useEffect(() => {
    void pipeline.classifier.warm();
  }, [pipeline]);
  useEffect(() => {
    pipeline.setCourse(courseId);
  }, [pipeline, courseId]);
  useRecognitionOnPause(engine, recognition);

  useEffect(
    () => () => {
      mew.dispose();
      void quiz.stop();
      tutor.interrupt();
      ink.dispose();
      voice.current?.stop();
    },
    [mew, tutor, ink, quiz],
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

  /** Holding Ctrl+Alt on the page (K6 §6.3): loops drawn meanwhile, then letting go. */
  const hold = useMemo(
    () => ({
      start: () => pipeline.clearCircled(),
      circle: (loop: readonly Vec[]) => pipeline.circle(loop),
      release: (heldAt: number) => {
        tutor.unlockAudio();
        pipeline.releaseHold(heldAt);
      },
      cancel: () => pipeline.clearCircled(),
    }),
    [pipeline, tutor],
  );

  /** The pen touched the page: don't talk over someone who's writing. */
  const penDown = useCallback(() => tutor.writing(), [tutor]);

  /**
   * Alt+C (K2 §11.3): check my work, the same turn as asking "is this right?" (during a quiz,
   * the grader checks the answer).
   */
  const checkWork = useCallback(() => {
    tutor.unlockAudio();
    if (quiz.active) {
      void quiz.check();
      return;
    }
    if (showThenYou.owns(pipeline.engine())) {
      void showThenYou.check({ quiet: false });
      return;
    }
    void tutor.respond({
      intent: "check_work",
      utterance: "Check my work.",
      triggeredAt: Date.now(),
      gateMs: 0,
    });
  }, [tutor, quiz, showThenYou, pipeline]);

  return {
    startListening,
    stopListening,
    say,
    summon,
    penDown,
    checkWork,
    ink,
    quiz,
    recognition,
    showThenYou,
    setSolutionRecords: pipeline.setRecords,
    hold,
  };
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
