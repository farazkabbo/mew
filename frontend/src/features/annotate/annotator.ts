import { type Line, planLiveMarkInk, strokeGroupHash, type BoardColors } from "@mew/ink";
import {
  ANNOTATION_LIMITS,
  type Annotation,
  type BBox,
  type Evidence,
  isOpen,
  type LineCheck,
  type LiveMarkKind,
  liveEvidence,
  type LiveMarkPlan,
  type MarkLevel,
  type MarkMethod,
  planLiveMark,
  type Recognition,
  type Stroke,
  wrongPart,
} from "@mew/shared";

import { derivationLines } from "../check/lines";
import type { PageChange, PageEngine } from "../notebook/engine";
import { strokesOf, studentLines } from "../notebook/export-line";
import { useNotebookUi } from "../notebook/store";
import { isShown } from "../notebook/visibility";
import type { AnnotationRecords } from "./records";
import { useLiveMarks } from "./store";

/**
 * Live annotations (K9, docs/NOTEBOOKS_K.md §7): the tutor marks each line the student finishes,
 * lightly and silently, like a teacher walking past the desk.
 *
 * - A line is finished when the pen rests 1.2 s after its last stroke, or a stroke starts another
 *   line: never mid-stroke or mid-word. Each is read (recognition, cached by strokes) and checked
 *   against the working above it by the checker router; `planLiveMark` decides the mark.
 * - Marks are tutor strokes with a `markKind`, put on the page outside the student's undo
 *   history and stored with their record in one transaction (no save button).
 * - Never drawn over the pen: a mark waits until the student pauses. At most six unresolved
 *   marks show at once; more wait.
 * - A fixed line's mark resolves (its tick appears); the same mistake again keeps one mark.
 * - Writing subjects get a rubric margin note at the Coach level; Coach also nudges "next
 *   step?" after 20 s without writing.
 */

export type AnnotatorDeps = {
  engine(): PageEngine | null;
  records: Pick<AnnotationRecords, "forPage" | "save" | "noteLineId">;
  recognize(engine: PageEngine, line: Line): Promise<Recognition | null>;
  /** A line's reading if it's already known (no network): the line above a finished one. */
  known(engine: PageEngine, line: Line): Recognition | undefined;
  /** Keeps a reading the student confirmed or typed (so it isn't asked for again). */
  remember(engine: PageEngine, line: Line, recognition: Recognition): void;
  /** The checker router's verdicts about `line` and the working leading to it. */
  check(engine: PageEngine, line: Line): Promise<LineCheck[]>;
  /** The level in force for the page's notebook (Off when the student turned checking off). */
  level(): MarkLevel;
  /** False while something else owns checking (a quiz, a Your Turn box). */
  active(): boolean;
  hideUntilDone(): boolean;
  colors(): BoardColors;
  viewport(): BBox;
  /** A margin note for a line of writing (the rubric, Coach level), or null. */
  rubric?(request: {
    line: string;
    previous: string[];
    subject: "biology" | "history" | "language" | "other";
  }): Promise<string | null>;
  /** A checker-verified line is right: what it counts as (§7.4), and the working it ends. */
  onEvidence?(evidence: Evidence, working: { pageId: string; lines: string[] }): void;
  /**
   * A verifier settled a line the student finished (a try at the problem): right, or wrong and
   * read with confidence. Show-then-You offers the answer after two wrong tries (§6).
   */
  onTry?(pageId: string, correct: boolean): void;
  /** A mark changed (the device's copy should reach the server). */
  onChanged?(): void;
  now?: () => number;
  timeout?: (run: () => void, ms: number) => () => void;
  newId?: () => string;
};

const CHECKED = new Set(["math", "chemistry", "code"]);
const WRITING = new Set(["biology", "history", "language", "other"]);
const CHECKABLE = new Set(["math", "physics", "chemistry", "programming"]);
const WRONG = new Set<LiveMarkKind>(["error", "missing", "unsure"]);
/** The pen counts as busy this long after a stroke: marks wait. */
const BUSY_MS = 500;

export class LiveAnnotator {
  private engine: PageEngine | null = null;
  private unsubscribe: (() => void) | null = null;
  private annotations: Annotation[] = [];
  private activeLineId: string | null = null;
  private cancelFinish: (() => void) | null = null;
  private cancelStuck: (() => void) | null = null;
  private lastStrokeAt = 0;
  /**
   * Lines already checked, by their exact strokes (an unchanged line isn't checked again), and
   * whether a verifier was definite about them.
   */
  private readonly checked = new Map<string, { key: string; definite: boolean }>();
  /** Lines credited with evidence (once each). */
  private readonly credited = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by every attach (a quick page flip supersedes a slow one). */
  private attaching = 0;
  private readonly now: () => number;
  private readonly timeout: (run: () => void, ms: number) => () => void;
  private readonly newId: () => string;

  constructor(private readonly deps: AnnotatorDeps) {
    this.now = deps.now ?? Date.now;
    this.timeout =
      deps.timeout ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        return () => clearTimeout(timer);
      });
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** Follows the page on screen (null: none). Its marks are read back from the device. */
  async attach(engine: PageEngine | null): Promise<void> {
    if (engine === this.engine) return;
    const attaching = ++this.attaching;
    // Moving on to another page (the next problem): the line still being written there is
    // finished, and marked on that page, before following the new one.
    const before = this.engine;
    const pending = before ? this.lineOf(before, this.activeLineId) : undefined;
    if (before && pending && this.cancelFinish) {
      this.cancelFinish();
      this.cancelFinish = null;
      await this.enqueue(() => this.finish(before, pending).then(() => undefined));
      if (attaching !== this.attaching) return; // another page was opened meanwhile
    }
    this.detach();
    this.engine = engine;
    if (!engine) return;
    this.unsubscribe = engine.subscribe((change) => this.onChange(change));
    const marks = await this.deps.records.forPage(engine.pageId);
    if (this.engine !== engine) return;
    this.annotations = marks;
    this.publish();
  }

  dispose(): void {
    this.detach();
  }

  /** The marks on the page, open ones only. */
  get open(): Annotation[] {
    return this.annotations.filter(isOpen);
  }

  /** The open, shown mark on a line, for the tutor's context (K9 §7.3). */
  markFor(line: Line): { kind: LiveMarkKind; note: string | null } | null {
    const engine = this.engine;
    if (!engine) return null;
    const mark = this.open
      .filter((a) => a.revealed && this.lineFor(engine, a)?.id === line.id)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return mark ? { kind: mark.markKind, note: mark.note } : null;
  }

  /** Settled: everything finished so far is checked and marked (tests, Alt+C). */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * After a writing pause, Mew asks first (K9 §7.2: `live_annotate`, no gate model call): the
   * current line is checked now; true when it got a definite verdict.
   */
  async annotateNow(): Promise<boolean> {
    const engine = this.engine;
    if (!engine || !this.deps.active() || this.deps.level() === "off") return false;
    const line = this.lineOf(engine, this.activeLineId) ?? studentLines(engine.doc).at(-1);
    if (!line) return false;
    this.cancelFinish?.();
    let definite = false;
    await this.enqueue(async () => {
      definite = await this.finish(engine, line);
    });
    return definite;
  }

  /** Hide-until-done: Alt+C or "check" shows what was worked out. Returns how many appeared. */
  async reveal(): Promise<number> {
    const engine = this.engine;
    if (!engine) return 0;
    const held = this.annotations.filter((a) => isOpen(a) && !a.revealed);
    if (held.length === 0) return 0;
    const shown = held.map((a) => ({ ...a, revealed: true, synced: false }));
    await this.deps.records.save({ put: shown, addStrokes: [], removeStrokeIds: [] });
    this.replace(shown);
    return shown.length;
  }

  /** "Not wrong" (a correction, for the eval sets) or "Hide": the mark comes off. */
  async dismiss(id: string, as: "not_wrong" | "hidden"): Promise<void> {
    const engine = this.engine;
    const mark = this.annotations.find((a) => a.id === id);
    if (!engine || !mark || !isOpen(mark)) return;
    const done = { ...mark, dismissedAs: as, synced: false };
    this.takeOff(engine, [done]);
  }

  /** "Why?" was asked about a mark (fixing it after counts as `after_explanation`). */
  async askedWhy(id: string): Promise<Annotation | null> {
    const mark = this.annotations.find((a) => a.id === id);
    if (!mark) return null;
    const asked = { ...mark, whyAsked: true, synced: false };
    await this.deps.records.save({ put: [asked], addStrokes: [], removeStrokeIds: [] });
    this.replace([asked]);
    return asked;
  }

  /**
   * The "?" (K9 §7.1: "I read: 3x + 1 = 19 — right?"): `typed` null means yes, it was read right;
   * otherwise it's what the line really says. Either way the line is checked again, as certain.
   */
  async reread(id: string, typed: string | null): Promise<void> {
    const engine = this.engine;
    const mark = this.annotations.find((a) => a.id === id);
    if (!engine || !mark) return;
    const line = this.lineFor(engine, mark);
    if (!line) return;
    const known = this.deps.known(engine, line);
    const text = (typed ?? known?.text ?? mark.recognizedText).trim().slice(0, 300);
    if (!text) return;
    const recognition: Recognition = {
      text,
      latex: typed === null ? (known?.latex ?? null) : text,
      subject: known?.subject ?? "math",
      confidence: 1,
    };
    this.deps.remember(engine, line, recognition);
    this.checked.delete(line.id);
    await this.enqueue(async () => {
      await this.finish(engine, line, recognition);
    });
  }

  // ─── Watching the page ────────────────────────────────────────────────────────────────────

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cancelFinish?.();
    this.cancelStuck?.();
    this.engine = null;
    this.annotations = [];
    this.activeLineId = null;
    this.publish();
  }

  private onChange(change: PageChange): void {
    const engine = this.engine;
    if (!engine) return;
    if (change === "draw") {
      this.lastStrokeAt = this.now();
      this.cancelStuck?.();
      const lines = studentLines(engine.doc);
      const latest = engine.doc
        .all()
        .reduce<Stroke | null>(
          (last, s) =>
            s.author === "student" && (!last || s.createdAt > last.createdAt) ? s : last,
          null,
        );
      const line = latest ? lines.find((l) => l.strokeIds.includes(latest.id)) : undefined;
      if (!line) return;
      // A stroke on another line: the one before is finished.
      if (this.activeLineId && this.activeLineId !== line.id) {
        const previous = lines.find((l) => l.id === this.activeLineId);
        if (previous) void this.enqueue(() => this.finish(engine, previous).then(() => undefined));
      }
      this.activeLineId = line.id;
      this.cancelFinish?.();
      this.cancelFinish = this.timeout(() => {
        const current = this.lineOf(engine, line.id);
        if (current) void this.enqueue(() => this.finish(engine, current).then(() => undefined));
      }, ANNOTATION_LIMITS.finishPauseMs);
    } else if (
      change === "erase" ||
      change === "delete" ||
      change === "undo" ||
      change === "redo"
    ) {
      void this.enqueue(() => this.dropOrphans(engine));
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((error: unknown) => {
      console.warn("[annotate]", error instanceof Error ? error.message : error);
    });
    return this.queue;
  }

  private lineOf(engine: PageEngine, id: string | null): Line | undefined {
    return id ? studentLines(engine.doc).find((l) => l.id === id) : undefined;
  }

  /** The line a mark is on now: the one holding at least half its strokes. */
  private lineFor(engine: PageEngine, mark: Annotation): Line | undefined {
    const strokes = new Set(mark.lineStrokeIds);
    const lines = studentLines(engine.doc);
    let best: { line: Line; shared: number } | null = null;
    for (const line of lines) {
      const shared = line.strokeIds.filter((id) => strokes.has(id)).length;
      if (shared > 0 && (!best || shared > best.shared)) best = { line, shared };
    }
    return best && best.shared * 2 >= strokes.size ? best.line : undefined;
  }

  // ─── Checking a finished line ─────────────────────────────────────────────────────────────

  /** Returns whether a verifier gave a definite verdict on the line. */
  private async finish(engine: PageEngine, line: Line, reading?: Recognition): Promise<boolean> {
    if (!this.deps.active()) return false;
    const level = this.deps.level();
    if (level === "off") return false;
    const key = strokeGroupHash(strokesOf(engine.doc, [line]));
    const before = this.checked.get(line.id);
    if (before?.key === key && !reading) return before.definite;
    this.checked.set(line.id, { key, definite: false });

    const recognition = reading ?? (await this.deps.recognize(engine, line));
    if (recognition) this.knownReadings.set(key, recognition);
    const checks = recognition ? await this.deps.check(engine, line) : [];
    if (this.engine !== engine) return false;
    const target = checks.find((c) => c.target && c.lineId === line.id);
    const text = (recognition?.latex ?? recognition?.text ?? "").trim();
    const previous = this.previousText(engine, line);
    const existing = this.open.find((a) => this.lineFor(engine, a)?.id === line.id) ?? null;
    const subject = recognition?.subject ?? null;
    const verdict = target?.verdict ?? "unknown";
    const checker = target && CHECKED.has(target.checker) ? target.checker : null;

    // Writing subjects: a rubric margin note, Coach level only.
    if (!target && subject && WRITING.has(subject) && level === "coach" && this.deps.rubric) {
      if (existing || !recognition?.text.trim()) return false;
      const note = await this.deps
        .rubric({
          line: recognition.text.slice(0, ANNOTATION_LIMITS.textChars),
          previous: this.previousLines(engine, line),
          subject: subject as "biology" | "history" | "language" | "other",
        })
        .catch(() => null);
      if (note && this.engine === engine) {
        await this.apply(engine, line, {
          plan: { remove: false, resolved: false, add: { kind: "margin", note } },
          existing: null,
          method: "rubric",
          verdict: "unknown",
          text: recognition.text,
          confidence: recognition.confidence,
          recognition,
        });
      }
      return false;
    }

    const plan = planLiveMark({
      check: { verdict, checker, reason: target?.reason ?? "" },
      text,
      confidence: recognition?.confidence ?? null,
      previousText: previous,
      checkable: subject !== null && CHECKABLE.has(subject),
      level,
      existing,
    });
    const method: MarkMethod =
      plan.add?.kind === "unsure" ? "reading" : ((checker ?? "math") as MarkMethod);
    const evidence = this.evidenceFor(engine, line, verdict, checker, existing);
    await this.apply(engine, line, {
      plan,
      existing,
      method,
      verdict,
      text,
      confidence: recognition?.confidence ?? null,
      recognition: recognition ?? undefined,
      evidence,
      wrongFocus: plan.add?.kind === "error" ? wrongPart(previous, text) : null,
    });
    if (evidence) {
      const lines = [...this.previousLines(engine, line), text].filter(Boolean).slice(-4);
      this.deps.onEvidence?.(evidence, { pageId: engine.pageId, lines });
    }
    // A wrong verdict on a doubtful reading isn't a try: it may be neb's mistake.
    const confident = (recognition?.confidence ?? 1) >= ANNOTATION_LIMITS.confidence;
    if (checker && (verdict === "correct" || (verdict === "incorrect" && confident))) {
      this.deps.onTry?.(engine.pageId, verdict === "correct");
    }
    if (verdict === "correct" && level === "coach") this.watchForStuck(engine, line);
    const definite = verdict === "correct" || verdict === "incorrect";
    this.checked.set(line.id, { key, definite });
    return definite;
  }

  /** §7.4: only checker-verified lines count, once each, by how they got right. */
  private evidenceFor(
    engine: PageEngine,
    line: Line,
    verdict: string,
    checker: string | null,
    existing: Annotation | null,
  ): Evidence | null {
    if (verdict !== "correct" || !checker || this.credited.has(line.id)) return null;
    this.credited.add(line.id);
    const history = this.annotations.filter((a) => this.lineFor(engine, a)?.id === line.id);
    const hadMark = history.some((a) => WRONG.has(a.markKind) && a.dismissedAs !== "not_wrong");
    const whyAsked = history.some((a) => a.whyAsked) || (existing?.whyAsked ?? false);
    return liveEvidence({ hadMark, whyAsked });
  }

  private previousText(engine: PageEngine, line: Line): string | null {
    const chain = derivationLines(studentLines(engine.doc), line);
    const above = chain.at(-2);
    return above ? this.textOf(engine, above) : null;
  }

  private previousLines(engine: PageEngine, line: Line): string[] {
    return derivationLines(studentLines(engine.doc), line)
      .slice(0, -1)
      .slice(-3)
      .map((l) => this.textOf(engine, l) ?? "")
      .filter(Boolean);
  }

  private textOf(engine: PageEngine, line: Line): string | null {
    const known =
      this.deps.known(engine, line) ??
      this.knownReadings.get(strokeGroupHash(strokesOf(engine.doc, [line])));
    return known ? (known.latex ?? known.text).trim() || null : null;
  }

  /** What lines were read as (filled as they're read: the line above is always read first). */
  private readonly knownReadings = new Map<string, Recognition>();

  // ─── Putting marks on (and off) the page ──────────────────────────────────────────────────

  private async apply(
    engine: PageEngine,
    line: Line,
    change: {
      plan: LiveMarkPlan;
      existing: Annotation | null;
      method: MarkMethod;
      verdict: Annotation["verdict"];
      text: string;
      confidence: number | null;
      recognition?: Recognition | undefined;
      evidence?: Evidence | null;
      wrongFocus?: { from: number; to: number } | null;
    },
  ): Promise<void> {
    const { plan, existing } = change;
    const now = this.now();
    const ended =
      plan.remove && existing
        ? {
            ...existing,
            resolvedAt: now,
            ...(plan.resolved && change.evidence && { evidence: change.evidence }),
            synced: false,
          }
        : null;
    if (!plan.add) {
      if (ended) this.takeOff(engine, [ended]);
      return;
    }
    // Never over the pen: wait for a pause. Past six unresolved marks, it waits unseen for room.
    await this.untilIdle();
    if (this.engine !== engine) return;
    const current = this.lineOf(engine, line.id) ?? line;
    const groupId = this.newId();
    const ink = planLiveMarkInk(
      {
        kind: plan.add.kind,
        note: plan.add.note,
        lineId: current.id,
        focus: change.wrongFocus ? this.focusBox(engine, current, change.wrongFocus) : undefined,
      },
      {
        pageId: engine.pageId,
        groupId,
        strokes: [...engine.doc.all()],
        lines: studentLines(engine.doc),
        activeLine: current,
        obstacles: engine.images.map((i): BBox => [i.x, i.y, i.width, i.height]),
        viewport: this.deps.viewport(),
        colors: this.deps.colors(),
        now,
        newId: this.newId,
      },
    );
    if (!ink) {
      if (ended) this.takeOff(engine, [ended]);
      return;
    }
    const mark: Annotation = {
      id: this.newId(),
      pageId: engine.pageId,
      lineId: await this.lineIdFor(engine, current),
      lineStrokeIds: current.strokeIds.slice(0, 2000),
      markKind: plan.add.kind,
      verdict: change.verdict,
      checkerMethod: change.method,
      recognizedText: change.text.slice(0, ANNOTATION_LIMITS.textChars),
      confidence: change.confidence,
      strokeGroupId: groupId,
      note: plan.add.note?.slice(0, ANNOTATION_LIMITS.noteChars) ?? null,
      hitBox: ink.hitBox,
      createdAt: now,
      resolvedAt: null,
      dismissedAs: null,
      revealed: !this.deps.hideUntilDone() && !(WRONG.has(plan.add.kind) && this.crowded()),
      whyAsked: false,
      evidence: plan.add.kind === "tick" ? (change.evidence ?? null) : null,
      synced: false,
    };
    const put = ended ? [ended, mark] : [mark];
    const removeIds = ended ? this.strokeIdsOf(engine, ended) : [];
    this.fade(engine, removeIds);
    const reading =
      change.recognition && mark.lineId
        ? { lineId: mark.lineId, recognition: change.recognition }
        : undefined;
    engine.applyMarks(ink.strokes, removeIds, () =>
      this.deps.records.save({
        put,
        addStrokes: ink.strokes,
        removeStrokeIds: removeIds,
        reading,
      }),
    );
    this.annotations = [...this.annotations.filter((a) => a.id !== ended?.id), ...put];
    this.publish();
    this.deps.onChanged?.();
  }

  private takeOff(engine: PageEngine, ended: Annotation[]): void {
    const removeIds = ended.flatMap((a) => this.strokeIdsOf(engine, a));
    this.fade(engine, removeIds);
    engine.applyMarks([], removeIds, () =>
      this.deps.records.save({ put: ended, addStrokes: [], removeStrokeIds: removeIds }),
    );
    // Removing nothing from the page (already gone) still records how the mark ended.
    if (removeIds.length === 0) {
      void this.deps.records.save({ put: ended, addStrokes: [], removeStrokeIds: [] });
    }
    this.replace(ended);
    this.showWaiting();
    this.deps.onChanged?.();
  }

  /** Marks coming off the page fade out (a resolved circle turns into its tick, §7.1). */
  private fade(engine: PageEngine, ids: readonly string[]): void {
    if (ids.length === 0) return;
    const strokes = ids
      .map((id) => engine.doc.get(id))
      .filter((s) => s !== undefined)
      .filter(isShown); // a mark held back or on a hidden layer doesn't flash on its way out
    useNotebookUi.getState().fadeMarks(strokes);
  }

  private replace(changed: readonly Annotation[]): void {
    const byId = new Map(changed.map((a) => [a.id, a]));
    this.annotations = this.annotations.map((a) => byId.get(a.id) ?? a);
    this.publish();
  }

  private strokeIdsOf(engine: PageEngine, mark: Annotation): string[] {
    return engine.doc
      .all()
      .filter((s) => s.groupId === mark.strokeGroupId && s.markKind !== undefined)
      .map((s) => s.id);
  }

  /** The strokes of the wrong part (by where they sit along the line), boxed. */
  private focusBox(engine: PageEngine, line: Line, part: { from: number; to: number }) {
    const [x, , w] = line.bbox;
    const from = x + part.from * w;
    const to = x + part.to * w;
    const inside = strokesOf(engine.doc, [line]).filter((s) => {
      const centre = s.bbox[0] + s.bbox[2] / 2;
      return centre >= from && centre <= to;
    });
    if (inside.length === 0 || inside.length === line.strokeIds.length) return undefined;
    const left = Math.min(...inside.map((s) => s.bbox[0]));
    const top = Math.min(...inside.map((s) => s.bbox[1]));
    const right = Math.max(...inside.map((s) => s.bbox[0] + s.bbox[2]));
    const bottom = Math.max(...inside.map((s) => s.bbox[1] + s.bbox[3]));
    return [left, top, right - left, bottom - top] as BBox;
  }

  /**
   * The line's lasting id: its earlier marks', else Notes Check's (so marks, the line's text and
   * its reading agree), else a new one.
   */
  private async lineIdFor(engine: PageEngine, line: Line): Promise<string> {
    const existing = this.annotations.find((a) => this.lineFor(engine, a)?.id === line.id);
    if (existing) return existing.lineId;
    const noted = await this.deps.records.noteLineId(engine.pageId, line.strokeIds);
    return noted ?? this.newId();
  }

  /** Resolves once the pen has rested a moment. */
  private untilIdle(): Promise<void> {
    return new Promise((resolve) => {
      const wait = () => {
        if (this.now() - this.lastStrokeAt >= BUSY_MS) return resolve();
        this.timeout(wait, BUSY_MS);
      };
      wait();
    });
  }

  /** Six unresolved marks are already showing (§7.2): more wait. */
  private crowded(): boolean {
    return (
      this.open.filter((a) => WRONG.has(a.markKind) && a.revealed).length >=
      ANNOTATION_LIMITS.visible
    );
  }

  /** A mark came off: marks waiting for room appear (oldest first), unless held until done. */
  private showWaiting(): void {
    if (this.deps.hideUntilDone()) return;
    const shown: Annotation[] = [];
    for (const mark of this.open
      .filter((a) => !a.revealed)
      .sort((a, b) => a.createdAt - b.createdAt)) {
      if (this.crowded()) break;
      const next = { ...mark, revealed: true, synced: false };
      shown.push(next);
      this.annotations = this.annotations.map((a) => (a.id === next.id ? next : a));
    }
    if (shown.length === 0) return;
    void this.deps.records.save({ put: shown, addStrokes: [], removeStrokeIds: [] });
    this.publish();
  }

  /** Coach: no writing for 20 s after a right line → "next step?" beside it (once). */
  private watchForStuck(engine: PageEngine, line: Line): void {
    this.cancelStuck?.();
    const since = this.lastStrokeAt;
    this.cancelStuck = this.timeout(() => {
      if (this.engine !== engine || this.lastStrokeAt !== since) return;
      if (this.deps.level() !== "coach" || !this.deps.active()) return;
      const current = this.lineOf(engine, line.id);
      if (!current) return;
      const nudged = this.annotations.some(
        (a) => a.checkerMethod === "coach" && this.lineFor(engine, a)?.id === current.id,
      );
      if (nudged) return;
      void this.enqueue(() =>
        this.apply(engine, current, {
          plan: { remove: false, resolved: false, add: { kind: "margin", note: "next step?" } },
          existing: null,
          method: "coach",
          verdict: "unknown",
          text: "",
          confidence: null,
        }),
      );
    }, ANNOTATION_LIMITS.stuckMs);
  }

  /** A line was erased or undone away: its marks come off with it. */
  private async dropOrphans(engine: PageEngine): Promise<void> {
    if (this.engine !== engine) return;
    const now = this.now();
    const orphans = this.open
      .filter((a) => !this.lineFor(engine, a))
      .map((a) => ({ ...a, resolvedAt: now, synced: false }));
    if (orphans.length > 0) this.takeOff(engine, orphans);
  }

  private publish(): void {
    const engine = this.engine;
    const open = this.open;
    useLiveMarks.getState().set(engine?.pageId ?? null, open);
    useNotebookUi
      .getState()
      .setUnrevealedMarks(new Set(open.filter((a) => !a.revealed).map((a) => a.strokeGroupId)));
  }
}
