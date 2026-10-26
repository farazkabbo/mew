import {
  ALL_RENDERERS,
  type BoardInput,
  type BoardPlan,
  type Line,
  planBoard,
  planBoxedAnswer,
  planYourTurn,
} from "@mew/ink";
import {
  type BBox,
  type BoardAction,
  type Evidence,
  inAnswerForm,
  type LineCheck,
  type MathCheckResponse,
  reconcileMarks,
  type SavedSolution,
  type SolutionRequest,
  showsAsWords,
  bringsInVariables,
  checkBalance,
  looksLikeReaction,
  sameReaction,
  withoutUnits,
  type SolutionResponse,
  type VerifiedSolution,
  type YourTurn,
} from "@mew/shared";

import { solutionRegion } from "../notebook/clip-page";
import type { PageEngine } from "../notebook/engine";
import { studentLines } from "../notebook/export-line";
import { useNotebookUi } from "../notebook/store";
import type { InkResult } from "../tutor/ink";
import type { LocalSolution, LocalYourTurn } from "./record";
import { useShowThenYou } from "./store";

/** What the flow needs from the notebook, the tutor and the services (injected for tests). */
export type ShowThenYouDeps = {
  engine(): PageEngine | null;
  ink: {
    render(
      actions: readonly BoardAction[],
      options?: {
        speech?: string;
        groupId?: string;
        plan?: (input: BoardInput) => BoardPlan | Promise<BoardPlan>;
        instant?: boolean;
      },
    ): Promise<InkResult>;
    written(): Promise<void>;
  };
  /** Says a line (caption and voice); resolves when it's been said. */
  say(text: string): Promise<void>;
  /** What the notebook knows about the problem (recognised lines, image, course). */
  request(utterance: string): Promise<SolutionRequest>;
  solve(request: SolutionRequest): Promise<SolutionResponse>;
  checkMath(steps: string[]): Promise<MathCheckResponse["results"] | null>;
  /** A line's recognised LaTeX (or text); null when it can't be read. */
  read(doc: PageEngine["doc"], line: Line): Promise<string | null>;
  /** A tutor turn about verified checks: circles the wrong line and gives the smallest hint. */
  hintTurn(checks: LineCheck[]): void;
  /** A tutor turn writing the next step (the hint step after two misses). */
  hintStep(): void;
  /** Learner evidence (only with a course). */
  attempt(
    conceptIds: readonly string[],
    evidence: Evidence,
    source: "practice" | "your_turn",
  ): void;
  /** "Skip for now": the concepts join the review queue instead. */
  review(conceptIds: readonly string[]): void;
  save(record: LocalSolution): Promise<void>;
  courseId(): string | null;
  yourTurnWanted(): boolean;
  newId(): string;
  now(): number;
};

/** A Your Turn's problem and answer key: from a solution just made, or one saved (K7). */
type TurnProblem = Pick<YourTurn, "problem" | "latex" | "answerKey" | "skill">;

/** Lines of the student's working that SymPy checks at once (with the problem: 8). */
const MAX_LINES = 7;

/**
 * Show-then-You in the notebook (K6, NOTEBOOKS_K §6.1): solve and verify (on the server), write
 * each step with its reason, box the answer, fold the solution into a tab, then a verified Your
 * Turn the student does alone, checked line by line. Only a Your Turn done without a peek or a
 * hint step counts as `independent`.
 */
export class ShowThenYou {
  constructor(private readonly deps: ShowThenYouDeps) {}

  get busy(): boolean {
    const phase = useShowThenYou.getState().phase;
    return phase === "solving" || phase === "showing";
  }

  /** "Just give me the answer." */
  async run(utterance: string): Promise<void> {
    if (this.busy) return;
    const engine = this.deps.engine();
    if (!engine) return;
    const store = useShowThenYou.getState();
    store.set({ phase: "solving", finished: null, offerHint: false });
    let response: SolutionResponse;
    try {
      const request = await this.deps.request(utterance);
      response = await this.deps.solve(request);
    } catch (error) {
      store.set({ phase: "idle" });
      await this.deps.say(
        error instanceof Error && error.message
          ? error.message
          : "I couldn't work that out just now — try again in a moment.",
      );
      return;
    }
    if (response.type !== "solution") {
      store.set({ phase: "idle" });
      // Never a confident wrong answer: say what's uncertain, and hints take over.
      await this.deps.say(
        response.type === "uncertain" ? response.speech : "Let's try that again.",
      );
      return;
    }
    await this.show(engine, response.solution);
  }

  private async show(engine: PageEngine, solution: VerifiedSolution): Promise<void> {
    const store = useShowThenYou.getState();
    store.set({ phase: "showing" });
    const groupId = this.deps.newId();
    const boxes: BBox[] = [];
    const draw = async (result: Promise<InkResult>, speech: string) => {
      const [ink] = await Promise.all([result, this.deps.say(speech)]);
      await this.deps.ink.written();
      if (ink.bbox) boxes.push(ink.bbox);
    };

    // Each step: its figure first when it has one, then the step, said with its reason.
    for (const step of solution.steps) {
      if (step.figure) {
        await draw(
          this.deps.ink.render([{ ...step.figure, anchor: { near: "free_space" } }], { groupId }),
          "",
        );
      }
      const action: BoardAction = step.latex
        ? { type: "write_math", latex: step.latex, anchor: { near: "below_active_line" } }
        : { type: "write_text", text: step.work, anchor: { near: "below_active_line" } };
      await draw(this.deps.ink.render([action], { speech: step.why, groupId }), step.why);
    }
    const answer = solution.finalAnswer;
    await draw(
      this.deps.ink.render([], {
        speech: answer.text,
        groupId,
        plan: (input) => planBoxedAnswer(answer, input),
      }),
      `So the answer is ${answer.text}.`,
    );

    const conceptIds = solution.yourTurn.conceptIds;
    const record: LocalSolution = {
      id: this.deps.newId(),
      pageId: engine.pageId,
      createdAt: this.deps.now(),
      groupId,
      bbox: union(boxes) ?? [0, 0, 0, 0],
      folded: true,
      problem: solution.problem.text,
      courseId: this.deps.courseId(),
      conceptIds,
      yourTurn: null,
    };
    // The original problem was explained, not solved alone: no mastery from it (§6.5).
    this.deps.attempt(conceptIds, "after_explanation", "practice");
    this.fold(record, true);

    if (solution.yourTurnVerified && this.deps.yourTurnWanted()) {
      record.yourTurn = await this.writeYourTurn(solution.yourTurn);
    } else {
      useShowThenYou.getState().set({ phase: "idle" });
    }
    await this.persist(record);
  }

  /**
   * Writes the Your Turn box under the work. `within` (K7: an entry saved from the screen) puts it
   * in that part of the page at once, without saying anything.
   */
  private async writeYourTurn(
    yourTurn: TurnProblem,
    within?: (input: BoardInput) => BoardInput,
  ): Promise<LocalYourTurn | null> {
    const groupId = this.deps.newId();
    let region: BBox | null = null;
    // A word problem is written as its words; its LaTeX is only for checking (it gives the
    // method away).
    const problem = {
      text: yourTurn.problem,
      latex: showsAsWords(yourTurn.problem) ? null : yourTurn.latex,
    };
    const written = this.deps.ink.render([], {
      speech: yourTurn.problem,
      groupId,
      instant: within !== undefined,
      plan: (input) => {
        const plan = planYourTurn(problem, within ? within(input) : input);
        region = plan.region;
        return plan;
      },
    });
    if (within) await written;
    else await Promise.all([written, this.deps.say(`Your turn: try this one on your own.`)]);
    await this.deps.ink.written();
    if (!region) {
      useShowThenYou.getState().set({ phase: "idle" });
      return null;
    }
    useShowThenYou.getState().set({ phase: "your_turn", offerHint: false, finished: null });
    return {
      problem: yourTurn.problem,
      latex: yourTurn.latex,
      answerKey: yourTurn.answerKey,
      skill: yourTurn.skill,
      groupId,
      region,
      peeked: false,
      hinted: false,
      misses: {},
      ticked: [],
      status: "open",
    };
  }

  /**
   * Entries saved from the screen with a worked solution ("just tell me the answer", K7 §6.2)
   * are written on their page the first time it's open: the solution folded under the note, its
   * answer boxed, then the Your Turn, all without animation. Once each (by the entry's image).
   */
  async adoptEntries(): Promise<void> {
    const engine = this.deps.engine();
    if (!engine || this.busy) return;
    const known = new Set(useShowThenYou.getState().solutions.map((s) => s.id));
    for (const image of engine.images) {
      const saved = image.entry?.solution;
      const id = `entry:${image.id}`;
      if (!saved || known.has(id)) continue;
      await this.adopt(engine, id, saved, solutionRegion(image));
    }
  }

  private async adopt(
    engine: PageEngine,
    id: string,
    saved: SavedSolution,
    region: BBox,
  ): Promise<void> {
    const within = (input: BoardInput): BoardInput => ({
      ...input,
      viewport: region,
      activeLine: undefined,
    });
    const groupId = this.deps.newId();
    const anchor = { near: "below_active_line" } as const;
    const steps = saved.steps.map((step): BoardAction =>
      step.latex
        ? { type: "write_math", latex: step.latex, anchor }
        : { type: "write_text", text: step.work, anchor },
    );
    const work = await this.deps.ink.render([], {
      groupId,
      instant: true,
      plan: (input) => planBoard(steps, within(input), ALL_RENDERERS),
    });
    const answer = await this.deps.ink.render([], {
      groupId,
      instant: true,
      plan: (input) => planBoxedAnswer(saved.finalAnswer, within(input)),
    });
    const record: LocalSolution = {
      id,
      pageId: engine.pageId,
      createdAt: this.deps.now(),
      groupId,
      bbox: union([work.bbox, answer.bbox].filter((b) => b !== null)) ?? region,
      folded: true,
      problem: saved.problem.text,
      courseId: this.deps.courseId(),
      // Concepts aren't known from the screen; the Your Turn still checks, without evidence.
      conceptIds: [],
      yourTurn: null,
    };
    this.fold(record, true);
    if (saved.yourTurn && this.deps.yourTurnWanted()) {
      record.yourTurn = await this.writeYourTurn(saved.yourTurn, within);
    }
    await this.persist(record);
  }

  /** The open Your Turn on the page on screen, if any. */
  private open(): LocalSolution | null {
    const pageId = this.deps.engine()?.pageId;
    return (
      useShowThenYou
        .getState()
        .solutions.findLast((s) => s.pageId === pageId && s.yourTurn?.status === "open") ?? null
    );
  }

  /** Whether a check (Alt+C, "check", a pen pause) is about the Your Turn: it has lines in it. */
  owns(engine: PageEngine | null): boolean {
    const record = this.open();
    if (!engine || !record?.yourTurn?.latex) return false;
    return linesIn(engine, record.yourTurn.region).length > 0;
  }

  /**
   * Checks the student's lines in the Your Turn box, top to bottom, from the problem (§6.1 step
   * 6): correct lines get a tick, a wrong one is circled with a hint (a tutor turn). Returns
   * false when there's nothing of the Your Turn's to check (the usual check runs instead).
   * `quiet` (a pen pause) only marks; asking ("check", Alt+C) also says how it's going.
   */
  async check({ quiet }: { quiet: boolean }): Promise<boolean> {
    const engine = this.deps.engine();
    const record = this.open();
    const turn = record?.yourTurn;
    if (!engine || !record || !turn?.latex) return false;
    const lines = linesIn(engine, turn.region).slice(0, MAX_LINES);
    if (lines.length === 0) {
      if (!quiet) await this.deps.say("Write your answer in the box, then ask me to check it.");
      return !quiet;
    }
    const texts = await Promise.all(lines.map((line) => this.deps.read(engine.doc, line)));
    // Only the unbroken run of readable lines from the top can be checked as steps.
    const readable = texts.findIndex((t) => !t);
    const count = readable === -1 ? lines.length : readable;
    if (count === 0) {
      if (!quiet) await this.deps.say("I can't read that yet — try writing it a bit larger.");
      return true;
    }
    const key = turn.answerKey.latex ?? turn.answerKey.text;
    if (looksLikeReaction(key)) {
      const last = lines[count - 1];
      const text = texts[count - 1];
      return last && text ? this.checkReaction(record, last, text, key, quiet) : true;
    }
    // Checked on their numbers (units left out); a line that brings in new variables is a formula
    // the student wrote down ("s = ½at²"), not a step from the line before: it's left alone.
    const steps = [withoutUnits(turn.latex)];
    const checked: Line[] = [];
    lines.slice(0, count).forEach((line, i) => {
      const text = withoutUnits(texts[i] ?? "");
      if (bringsInVariables(text, steps)) return;
      steps.push(text);
      checked.push(line);
    });
    if (checked.length === 0) {
      if (!quiet) await this.deps.say("Good start. Now put the numbers in.");
      return true;
    }
    const results = await this.deps.checkMath(steps);
    if (!results) {
      if (!quiet) await this.deps.say("I can't check right now — try again in a moment.");
      return true;
    }
    const last = checked.at(-1);
    const checks: LineCheck[] = results.flatMap((r) => {
      const line = checked[r.index - 1];
      if (!line || r.index === 0) return [];
      return [
        {
          lineId: line.id,
          checker: "math" as const,
          verdict: r.verdict,
          reason: r.reason,
          detail: r.detail ?? null,
          target: line.id === last?.id,
        },
      ];
    });

    const wrong = checks.find((c) => c.verdict === "incorrect");
    if (wrong) {
      const misses = (turn.misses[wrong.lineId] ?? 0) + 1;
      turn.misses = { ...turn.misses, [wrong.lineId]: misses };
      // Unlimited tries; after two on the same line, a hint step is offered.
      if (misses >= 2) useShowThenYou.getState().set({ offerHint: true });
      await this.persist(record);
      // The wrong line is what the turn is about: it gets the circle (verifiers outrank the model).
      this.deps.hintTurn(checks.map((c) => ({ ...c, target: c.lineId === wrong.lineId })));
      return true;
    }

    // Ticks for newly correct lines (quietly: no voice, no model call).
    const fresh = checks.filter((c) => c.verdict === "correct" && !turn.ticked.includes(c.lineId));
    if (fresh.length > 0) {
      turn.ticked = [...turn.ticked, ...fresh.map((c) => c.lineId)];
      await this.deps.ink.render(
        reconcileMarks(
          [],
          fresh.map((c) => ({ ...c, target: true })),
        ),
      );
    }
    const lastText = steps.at(-1);
    if (checked.at(-1) === lines[count - 1] && lastText && (await this.isAnswer(lastText, turn))) {
      await this.finish(record);
      return true;
    }
    await this.persist(record);
    if (!quiet) await this.deps.say("So far so good. Keep going.");
    return true;
  }

  /**
   * A chemistry Your Turn ("balance Mg + O₂ → MgO"): the latest line is checked by the atom and
   * charge balance. Balanced and the same reaction: done. Unbalanced: circled with the counts as
   * the hint. Anything else (another reaction, unreadable) gets no mark.
   */
  private async checkReaction(
    record: LocalSolution,
    line: Line,
    text: string,
    key: string,
    quiet: boolean,
  ): Promise<boolean> {
    const turn = record.yourTurn;
    if (!turn) return false;
    const balance = checkBalance(text);
    if (balance.verdict === "incorrect" && sameReaction(text, key)) {
      turn.misses = { ...turn.misses, [line.id]: (turn.misses[line.id] ?? 0) + 1 };
      if ((turn.misses[line.id] ?? 0) >= 2) useShowThenYou.getState().set({ offerHint: true });
      await this.persist(record);
      this.deps.hintTurn([
        {
          lineId: line.id,
          checker: "chemistry",
          verdict: "incorrect",
          reason: balance.reason,
          detail: balance.detail,
          target: true,
        },
      ]);
      return true;
    }
    if (balance.verdict === "correct" && sameReaction(text, key)) {
      const check: LineCheck = {
        lineId: line.id,
        checker: "chemistry",
        verdict: "correct",
        reason: balance.reason,
        target: true,
      };
      await this.deps.ink.render(reconcileMarks([], [check]));
      await this.finish(record);
      return true;
    }
    await this.persist(record);
    if (!quiet) await this.deps.say("Balance the reaction in the box, then ask me again.");
    return true;
  }

  /**
   * The line is the answer, in its final form ("x = 5", not the equivalent "5x = 25" on the way
   * there), and equal to the key: each follows from the other.
   */
  private async isAnswer(latex: string, turn: LocalYourTurn): Promise<boolean> {
    const key = turn.answerKey.latex && withoutUnits(turn.answerKey.latex);
    if (!key || !inAnswerForm(latex, key)) return false;
    const results = await this.deps.checkMath([key, latex, key]);
    return Boolean(
      results && results.length === 3 && results.slice(1).every((r) => r.verdict === "correct"),
    );
  }

  private async finish(record: LocalSolution): Promise<void> {
    const turn = record.yourTurn;
    if (!turn) return;
    turn.status = "done";
    const helped = turn.peeked || turn.hinted;
    this.deps.attempt(record.conceptIds, helped ? "with_hint" : "independent", "your_turn");
    const text = helped ? "You got it." : "You got it on your own.";
    useShowThenYou.getState().set({ phase: "done", finished: text, offerHint: false });
    await this.persist(record);
    await this.deps.say(text);
  }

  /** Opens a folded solution for a look; it counts as a hint for an open Your Turn. */
  async peek(solutionId: string): Promise<void> {
    const store = useShowThenYou.getState();
    const record = store.solutions.find((s) => s.id === solutionId);
    if (!record) return;
    const peeking = new Set(store.peeking);
    if (peeking.has(solutionId)) {
      peeking.delete(solutionId);
      store.set({ peeking });
      this.fold(record, true);
      return;
    }
    peeking.add(solutionId);
    store.set({ peeking });
    this.fold(record, false);
    const open = this.open();
    if (open?.yourTurn && !open.yourTurn.peeked) {
      open.yourTurn.peeked = true;
      await this.persist(open);
    }
  }

  /** The hint step offered after two misses on a line: it counts as a hint. */
  async takeHintStep(): Promise<void> {
    const record = this.open();
    if (!record?.yourTurn) return;
    record.yourTurn.hinted = true;
    useShowThenYou.getState().set({ offerHint: false });
    await this.persist(record);
    this.deps.hintStep();
  }

  /** "Skip for now": nothing is logged; the concepts join the review queue. */
  async skip(): Promise<void> {
    const record = this.open();
    if (!record?.yourTurn) return;
    record.yourTurn.status = "skipped";
    this.deps.review(record.conceptIds);
    useShowThenYou.getState().set({ phase: "idle", offerHint: false });
    await this.persist(record);
    await this.deps.say("Saved for your review.");
  }

  /** "One more": another verified Your Turn of the same skill, under this one. */
  async oneMore(): Promise<void> {
    const store = useShowThenYou.getState();
    const engine = this.deps.engine();
    const done = store.solutions.findLast((s) => s.pageId === engine?.pageId && s.yourTurn);
    if (!engine || !done?.yourTurn || this.busy) return;
    store.set({ phase: "solving", finished: null });
    let response: SolutionResponse;
    try {
      const request = await this.deps.request("One more, please.");
      response = await this.deps.solve({
        ...request,
        variantOf: { problem: done.yourTurn.problem, skill: done.yourTurn.skill },
      });
    } catch {
      store.set({ phase: "idle" });
      await this.deps.say("I couldn't make another one just now.");
      return;
    }
    if (response.type !== "your_turn") {
      store.set({ phase: "idle" });
      await this.deps.say(response.type === "uncertain" ? response.speech : "Let's try later.");
      return;
    }
    const record: LocalSolution = {
      ...done,
      id: this.deps.newId(),
      createdAt: this.deps.now(),
      conceptIds:
        response.yourTurn.conceptIds.length > 0 ? response.yourTurn.conceptIds : done.conceptIds,
      // The variant has no worked solution of its own: nothing to fold or peek.
      groupId: "",
      bbox: [0, 0, 0, 0],
      folded: false,
      yourTurn: null,
    };
    record.yourTurn = await this.writeYourTurn(response.yourTurn);
    await this.persist(record);
  }

  /** "Back to your work": the panel goes away; the Your Turn stays on the page. */
  back(): void {
    useShowThenYou.getState().set({ phase: "idle", finished: null, offerHint: false });
  }

  /** Shows the page's records (on opening it): folded solutions stay folded. */
  load(records: readonly LocalSolution[]): void {
    const store = useShowThenYou.getState();
    const open = records.findLast((r) => r.yourTurn?.status === "open");
    store.set({
      solutions: [...records],
      peeking: new Set(),
      offerHint: false,
      finished: null,
      phase: this.busy ? store.phase : open ? "your_turn" : "idle",
    });
    useNotebookUi
      .getState()
      .setFoldedGroups(new Set(records.filter((r) => r.folded && r.groupId).map((r) => r.groupId)));
  }

  /** Hides or shows a solution's ink (a peek doesn't change that it's kept folded). */
  private fold(record: LocalSolution, folded: boolean): void {
    if (!record.groupId) return;
    const ui = useNotebookUi.getState();
    const groups = new Set(ui.foldedGroups);
    if (folded) groups.add(record.groupId);
    else groups.delete(record.groupId);
    ui.setFoldedGroups(groups);
    useShowThenYou.getState().upsert({ ...record });
  }

  private async persist(record: LocalSolution): Promise<void> {
    useShowThenYou
      .getState()
      .upsert({ ...record, ...(record.yourTurn && { yourTurn: { ...record.yourTurn } }) });
    await this.deps.save(record).catch(() => undefined);
  }
}

/** The student's lines whose middle is inside `region`, top to bottom. */
export function linesIn(engine: PageEngine, region: BBox): Line[] {
  const [x, y, w, h] = region;
  return studentLines(engine.doc)
    .filter(({ bbox: [lx, ly, lw, lh] }) => {
      const cx = lx + lw / 2;
      const cy = ly + lh / 2;
      return cx >= x && cx <= x + w && cy >= y && cy <= y + h;
    })
    .sort((a, b) => a.bbox[1] - b.bbox[1]);
}

function union(boxes: readonly BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((b) => b[0]));
  const top = Math.min(...boxes.map((b) => b[1]));
  const right = Math.max(...boxes.map((b) => b[0] + b[2]));
  const bottom = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [left, top, right - left, bottom - top];
}
