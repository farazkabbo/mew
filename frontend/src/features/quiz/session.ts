import type { Line, PageDocument } from "@mew/ink";
import {
  type AttemptRequest,
  type BoardAction,
  type Concept,
  type ConceptProgress,
  type CourseDetail,
  type CourseProgress,
  type Evidence,
  type Lesson,
  localDate,
  planExam,
  progressFor,
  QUIZ_LIMITS,
  type QuizContext,
  type QuizGrade,
  type QuizGradeRequest,
  quizQueue,
} from "@mew/shared";

import { INITIAL_QUIZ, type QuizQuestion, useQuiz } from "./store";

export type QuizApi = {
  detail(courseId: string): Promise<CourseDetail>;
  progress(courseId: string): Promise<CourseProgress>;
  lesson(courseId: string, conceptId: string): Promise<Lesson>;
  attempt(courseId: string, attempt: AttemptRequest): Promise<ConceptProgress>;
};

export type QuizDeps = {
  api: QuizApi;
  /** Grades an answer; null when no grader is available (the student then self-grades). */
  grade(request: QuizGradeRequest): Promise<QuizGrade | null>;
  doc(): PageDocument | null;
  /** Lines of the student's handwriting on the page. */
  lines(doc: PageDocument): Line[];
  /** Recognised text of a line, if recognition is available. */
  recognize(doc: PageDocument, line: Line): Promise<string | null>;
  /** PNG (base64) of the given lines, or null if it can't be made. */
  renderAnswer(doc: PageDocument, lines: readonly Line[]): Promise<string | null>;
  /** What the student said since a moment (their own words, not the tutor's echo). */
  spokenSince(at: number, exclude?: string): string;
  /** Writes marks (tick / circle) as tutor ink. */
  mark(actions: BoardAction[]): void;
  /** Says a line out loud (with a caption); resolves when it has been said. */
  say(text: string): Promise<void>;
  now(): number;
};

/** Wrong checks of one question before the model answer is shown. */
const MAX_TRIES = 3;

/**
 * "Quiz me" (brief §12): asks practice questions of a course in the notebook, in the order the
 * learner model suggests, grades the written (or spoken) answer, marks it on the page, and
 * records one attempt per question with honest evidence: on their own, after a hint (the hint
 * button, help from the tutor, or a wrong first try), or after being shown the answer.
 */
export class QuizSession {
  private queue: string[] = [];
  private concepts = new Map<string, Concept>();
  private readonly asked = new Set<string>();
  private lastConcept: string | null = null;
  /** When the question was asked (answer lines are written after it). */
  private askedAt = 0;
  /** When the question had been read out (speech after it is the answer). */
  private listenFrom = 0;
  private tries = 0;
  private helped = false;
  private shown = false;
  private recorded = false;
  /** Bumped on start/stop, so late replies from an older quiz are ignored. */
  private generation = 0;

  constructor(private readonly deps: QuizDeps) {}

  get active(): boolean {
    return useQuiz.getState().active;
  }

  /** The question being answered, for the tutor's context (never the model answer). */
  context(): QuizContext | null {
    const { active, question, phase } = useQuiz.getState();
    if (!active || !question || phase === "done" || phase === "finished") return null;
    return { concept: question.conceptTitle, question: question.question };
  }

  async start(courseId: string): Promise<void> {
    const generation = ++this.generation;
    this.asked.clear();
    this.lastConcept = null;
    useQuiz.setState({ ...INITIAL_QUIZ, active: true, courseId });
    try {
      const [detail, progress] = await Promise.all([
        this.deps.api.detail(courseId),
        this.deps.api.progress(courseId).catch(() => ({ concepts: [] })),
      ]);
      if (generation !== this.generation) return;
      useQuiz.setState({ courseTitle: detail.course.title });
      if (detail.course.status !== "ready" || detail.concepts.length === 0) {
        this.finishQuiz("This course isn't ready for a quiz yet: review its concepts first.");
        return;
      }
      this.concepts = new Map(detail.concepts.map((c) => [c.id, c]));
      const ids = detail.concepts.map((c) => c.id);
      const map = progressFor(ids, progress.concepts);
      const today = detail.course.exam_date
        ? planExam({
            orderedIds: ids,
            progress: map,
            examDate: detail.course.exam_date,
            today: localDate(new Date(this.deps.now())),
          }).days[0]
        : undefined;
      this.queue = quizQueue(ids, map, today ? [...today.learn, ...today.review] : []);
      await this.ask(generation);
    } catch {
      if (generation === this.generation) this.finishQuiz("Couldn't start the quiz.");
    }
  }

  /** Moves on to the next question (an unfinished, attempted one is recorded as not known). */
  async next(): Promise<void> {
    await this.settle();
    await this.ask(this.generation);
  }

  async stop(): Promise<void> {
    await this.settle();
    this.generation++;
    useQuiz.setState(INITIAL_QUIZ);
  }

  hint(): void {
    const { question, phase } = useQuiz.getState();
    if (!question?.hint || phase !== "asking") return;
    this.helped = true;
    useQuiz.setState({ hintShown: true });
    void this.deps.say(question.hint);
  }

  /** The student asked the tutor for help with this question. */
  helpedByTutor(): void {
    if (useQuiz.getState().phase === "asking") this.helped = true;
  }

  /** Shows the model answer: a correct answer after this counts as "after an explanation". */
  reveal(): void {
    if (!useQuiz.getState().question) return;
    this.shown = true;
    useQuiz.setState({ revealed: true });
  }

  /** Grades what the student wrote (and said) since the question was asked. */
  async check(utterance?: string): Promise<void> {
    const state = useQuiz.getState();
    const question = state.question;
    if (!question || state.phase !== "asking") return;
    const generation = this.generation;
    const doc = this.deps.doc();
    const lines = doc ? this.deps.lines(doc).filter((l) => l.lastCreatedAt >= this.askedAt) : [];
    const spoken = this.deps.spokenSince(this.listenFrom, utterance).slice(-500);
    if (lines.length === 0 && !spoken.trim()) {
      useQuiz.setState({ message: "Write or say your answer first, then check it." });
      return;
    }
    useQuiz.setState({ phase: "grading", message: null });

    const answerLines = lines.slice(-QUIZ_LIMITS.recognizedLines);
    const [recognized, image] = doc
      ? await Promise.all([
          Promise.all(answerLines.map((l) => this.deps.recognize(doc, l).catch(() => null))),
          this.deps.renderAnswer(doc, answerLines).catch(() => null),
        ])
      : [[], null];
    const grade = await this.deps
      .grade({
        concept: question.conceptTitle.slice(0, QUIZ_LIMITS.conceptChars),
        question: question.question.slice(0, QUIZ_LIMITS.questionChars),
        expected: question.answer.slice(0, QUIZ_LIMITS.answerChars),
        recognized: recognized
          .filter((t): t is string => Boolean(t))
          .map((t) => t.slice(0, QUIZ_LIMITS.lineChars)),
        spoken,
        image,
      })
      .catch(() => null);
    if (generation !== this.generation) return;

    const target = answerLines.at(-1);
    if (!grade) {
      // No grader: the student compares their answer with the model answer.
      useQuiz.setState({ phase: "self" });
      return;
    }
    useQuiz.setState({ feedback: { verdict: grade.verdict, text: grade.feedback } });
    void this.deps.say(grade.feedback);
    if (grade.verdict === "correct") {
      if (target) this.deps.mark([{ type: "mark_correct", targetLineId: target.id }]);
      await this.finish(true);
      return;
    }
    if (grade.verdict === "unreadable") {
      useQuiz.setState({ phase: "asking" });
      return;
    }
    this.tries++;
    if (target) {
      const note = grade.note.trim() || "check this";
      this.deps.mark([{ type: "mark_error", targetLineId: target.id, note }]);
    }
    if (this.tries >= MAX_TRIES) {
      this.reveal();
      await this.finish(false);
    } else {
      useQuiz.setState({ phase: "asking" });
    }
  }

  /** Without a grader: the student says whether their answer matched. */
  async selfGrade(correct: boolean): Promise<void> {
    if (useQuiz.getState().phase !== "self") return;
    if (correct) {
      const doc = this.deps.doc();
      const target = doc
        ? this.deps
            .lines(doc)
            .filter((l) => l.lastCreatedAt >= this.askedAt)
            .at(-1)
        : undefined;
      if (target) this.deps.mark([{ type: "mark_correct", targetLineId: target.id }]);
    }
    await this.finish(correct);
  }

  private evidence(): Evidence {
    if (this.shown) return "after_explanation";
    return this.helped || this.tries > 0 ? "with_hint" : "independent";
  }

  private async finish(correct: boolean): Promise<void> {
    const { question, courseId } = useQuiz.getState();
    if (!question || !courseId || this.recorded) return;
    this.recorded = true;
    const generation = this.generation;
    useQuiz.setState({ phase: "done" });
    const progress = await this.deps.api
      .attempt(courseId, {
        conceptId: question.conceptId,
        correct,
        evidence: this.evidence(),
        source: "quiz",
      })
      .catch(() => null);
    if (generation !== this.generation) return;
    const { asked, correct: right } = useQuiz.getState();
    useQuiz.setState({
      asked: asked + 1,
      correct: right + (correct ? 1 : 0),
      status: progress?.status ?? null,
      message: progress ? null : "Couldn't save this answer.",
    });
  }

  /** An attempted (or revealed) question that wasn't finished counts as not known yet. */
  private async settle(): Promise<void> {
    if (!this.recorded && (this.tries > 0 || this.shown)) await this.finish(false);
  }

  private async ask(generation: number): Promise<void> {
    const conceptId = this.pickConcept();
    const concept = conceptId ? this.concepts.get(conceptId) : undefined;
    const { courseId } = useQuiz.getState();
    if (!concept || !courseId) {
      this.finishQuiz("Nothing to ask yet.");
      return;
    }
    useQuiz.setState({
      phase: "loading",
      question: null,
      feedback: null,
      status: null,
      hintShown: false,
      revealed: false,
      message: null,
    });
    const lesson = await this.deps.api.lesson(courseId, concept.id).catch(() => null);
    if (generation !== this.generation) return;
    const question = this.pickQuestion(concept, lesson);
    this.tries = 0;
    this.helped = false;
    this.shown = false;
    this.recorded = false;
    this.askedAt = this.deps.now();
    this.listenFrom = this.askedAt;
    useQuiz.setState({ phase: "asking", question });
    await this.deps.say(question.question);
    if (generation === this.generation && useQuiz.getState().question === question) {
      this.listenFrom = this.deps.now();
    }
  }

  /** The next concept in the queue, not the same one twice in a row when there's a choice. */
  private pickConcept(): string | null {
    const index = this.queue.length > 1 && this.queue[0] === this.lastConcept ? 1 : 0;
    const [id] = this.queue.splice(index, 1);
    if (id === undefined) return null;
    this.queue.push(id); // round and round, for long sessions
    this.lastConcept = id;
    return id;
  }

  /** A practice question from the lesson not yet asked; else a recall question. */
  private pickQuestion(concept: Concept, lesson: Lesson | null): QuizQuestion {
    const practice = lesson?.practice ?? [];
    const index = practice.findIndex((_, i) => !this.asked.has(`${concept.id}:${i}`));
    const base = { conceptId: concept.id, conceptTitle: concept.title };
    const found = practice[index];
    if (found) {
      this.asked.add(`${concept.id}:${index}`);
      return { ...base, ...found, fromLesson: true };
    }
    return {
      ...base,
      question: `In your own words: what is “${concept.title}”, and why does it matter?`,
      answer: concept.summary || concept.title,
      hint: "",
      fromLesson: false,
    };
  }

  private finishQuiz(message: string): void {
    useQuiz.setState({ phase: "finished", question: null, message });
  }
}
