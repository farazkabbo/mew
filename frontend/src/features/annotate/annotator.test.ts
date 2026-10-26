import { type Line, PageDocument, strokeBBox } from "@mew/ink";
import type {
  Annotation,
  Evidence,
  LineCheck,
  MarkLevel,
  Point,
  Recognition,
  Stroke,
} from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageChange, PageEngine } from "../notebook/engine";
import { useNotebookUi } from "../notebook/store";
import { LiveAnnotator } from "./annotator";
import { useMarkPrefs } from "./prefs";

const PAGE = "11111111-1111-4111-8111-111111111111";
let ids = 0;
const newId = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;

/** A line of `letters` zig-zag strokes at height `y` (lines differ by their y). */
function line(y: number, letters: number, t0: number, x = 100): Stroke[] {
  return Array.from({ length: letters }, (_, i) => {
    const left = x + i * 22;
    const points: Point[] = [
      [left, y + 24, 0.5, 0],
      [left + 8, y, 0.5, 10],
      [left + 16, y + 24, 0.5, 20],
    ];
    return {
      id: newId(),
      pageId: PAGE,
      author: "student",
      tool: "pen",
      points,
      color: "#1d1c1a",
      width: 3,
      bbox: strokeBBox(points, 3),
      createdAt: t0 + i,
    } satisfies Stroke;
  });
}

type Reading = {
  text: string;
  confidence?: number;
  verdict?: LineCheck["verdict"];
  reason?: string;
};

function setup(options: { level?: MarkLevel; hide?: boolean } = {}) {
  let now = 1_000_000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const doc = new PageDocument([]);
  const listeners = new Set<(change: PageChange) => void>();
  const history: string[] = [];
  const engine = {
    pageId: PAGE,
    doc,
    images: [],
    subscribe: (listener: (change: PageChange) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applyMarks: (
      added: readonly Stroke[],
      removedIds: readonly string[],
      write: () => Promise<void>,
    ) => {
      const removed = removedIds.map((id) => doc.get(id)).filter((s) => s !== undefined);
      doc.apply({ removed, added: [...added] });
      void write();
    },
  } as unknown as PageEngine;
  const emit = (change: PageChange) => listeners.forEach((l) => l(change));
  /** What each line (by its top) is read as, and what the checker says of it. */
  const readings = new Map<number, Reading>();
  const readingOf = (l: Line) => readings.get(Math.round(l.bbox[1] / 10) * 10);
  const saved: Annotation[] = [];
  const evidence: Evidence[] = [];
  const check = vi.fn(async (_: PageEngine, l: Line): Promise<LineCheck[]> => {
    const reading = readingOf(l);
    if (!reading?.verdict) return [];
    return [
      {
        lineId: l.id,
        checker: "math",
        verdict: reading.verdict,
        reason:
          reading.reason ?? (reading.verdict === "correct" ? "equivalent" : "changes_solutions"),
        detail: null,
        target: true,
      },
    ];
  });
  const known = new Map<string, Recognition>();
  const live = new LiveAnnotator({
    engine: () => engine,
    records: {
      forPage: async () => [],
      save: async (change) => {
        saved.push(...change.put);
      },
      noteLineId: async () => null,
    },
    recognize: async (_, l) => {
      const reading = readingOf(l);
      if (!reading) return null;
      const recognition: Recognition = {
        text: reading.text,
        latex: reading.text,
        subject: "math",
        confidence: reading.confidence ?? 0.95,
      };
      known.set(l.id, recognition);
      return recognition;
    },
    known: (_, l) => known.get(l.id),
    remember: (_, l, r) => known.set(l.id, r),
    check,
    level: () => options.level ?? "normal",
    active: () => true,
    hideUntilDone: () => options.hide ?? false,
    colors: () => ({ ink: "#8a7bf0", error: "#c8432b", correct: "#2f7d55" }),
    viewport: () => [0, 0, 1200, 900],
    onEvidence: (e) => evidence.push(e),
    now: () => now,
    timeout: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    newId,
  });
  void live.attach(engine);

  const write = (strokes: Stroke[]) => {
    for (const stroke of strokes) {
      doc.add([stroke]);
      history.push(stroke.id);
      emit("draw");
    }
  };
  const erase = (strokes: Stroke[]) => {
    doc.remove(strokes.map((s) => s.id));
    emit("erase");
  };
  /** Time passes: due timers run, then everything queued settles. */
  const wait = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.live = false;
      due.run();
      await flush();
    }
    now = until;
    await flush();
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  const marks = () => doc.all().filter((s) => s.markKind !== undefined);
  return { live, doc, readings, write, erase, wait, marks, saved, evidence, check, history };
}

beforeEach(() => {
  useNotebookUi.setState({ unrevealedMarks: new Set(), marksHiddenOn: new Set() });
});

describe("live annotations (K9 §7)", () => {
  it("circles a wrong line with a hint once the pen rests, silently and outside undo", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 26", verdict: "incorrect" });
    t.write(line(100, 6, 0));
    await t.wait(300);
    // A new line starts: the first one is finished (nothing to mark on a first line).
    t.write(line(170, 4, 100));
    await t.wait(0);
    expect(t.check).toHaveBeenCalledTimes(1);
    expect(t.marks()).toEqual([]);
    // Mid-line (the pen still moving): nothing yet.
    await t.wait(900);
    expect(t.check).toHaveBeenCalledTimes(1);
    await t.wait(400);
    expect(t.check).toHaveBeenCalledTimes(2);
    const marks = t.marks();
    expect(marks.length).toBeGreaterThan(1);
    expect(new Set(marks.map((s) => s.markKind))).toEqual(new Set(["error"]));
    const [mark] = t.live.open;
    expect(mark).toMatchObject({ markKind: "error", note: "sign?", verdict: "incorrect" });
    expect(t.saved.at(-1)?.id).toBe(mark?.id);
  });

  it("resolves a fixed line into a tick, logs with_hint, and never marks the same mistake twice", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 26", verdict: "incorrect" });
    t.write(line(100, 6, 0));
    await t.wait(1300);
    const wrong = line(170, 4, 100);
    t.write(wrong);
    await t.wait(1300);
    expect(t.live.open).toHaveLength(1);

    // The same mistake written again (other strokes, same reading): still one mark.
    t.erase(wrong);
    await t.wait(10);
    const again = line(170, 4, 200, 102);
    t.write(again);
    await t.wait(1300);
    expect(t.live.open.filter((a) => a.markKind === "error")).toHaveLength(1);

    // Fixed: the circle goes, a tick comes, and it counts as with a hint.
    t.readings.set(170, { text: "3x = 12", verdict: "correct" });
    t.write(line(170, 1, 300, 210));
    await t.wait(1300);
    expect(t.live.open.map((a) => a.markKind)).toEqual(["tick"]);
    expect(t.marks().every((s) => s.markKind === "tick")).toBe(true);
    expect(t.saved.some((a) => a.markKind === "error" && a.resolvedAt !== null)).toBe(true);
    expect(t.evidence).toEqual(["with_hint"]);
  });

  it("gives a line it couldn't read a ? and never an error mark", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 2b", verdict: "incorrect", confidence: 0.5 });
    t.write(line(100, 6, 0));
    await t.wait(1300);
    t.write(line(170, 4, 100));
    await t.wait(1300);
    expect(t.live.open.map((a) => a.markKind)).toEqual(["unsure"]);
    expect(t.marks().some((s) => s.markKind === "error")).toBe(false);

    // "I read 3x = 2b — right?" "No, it says 3x = 12": checked again, as certain.
    t.readings.set(170, { text: "3x = 12", verdict: "correct" });
    const [unsure] = t.live.open;
    await t.live.reread(unsure?.id ?? "", "3x = 12");
    expect(t.live.open.map((a) => a.markKind)).toEqual(["tick"]);
  });

  it("ticks a right first try (independent), and Quiet shows errors only", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 12", verdict: "correct" });
    t.write(line(100, 6, 0));
    await t.wait(1300);
    t.write(line(170, 4, 100));
    await t.wait(1300);
    expect(t.live.open.map((a) => a.markKind)).toEqual(["tick"]);
    expect(t.evidence).toEqual(["independent"]);

    const quiet = setup({ level: "quiet" });
    quiet.readings.set(100, { text: "3x + 7 = 19" });
    quiet.readings.set(170, { text: "3x = 12", verdict: "correct" });
    quiet.write(line(100, 6, 0));
    await quiet.wait(1300);
    quiet.write(line(170, 4, 100));
    await quiet.wait(1300);
    expect(quiet.marks()).toEqual([]);
  });

  it("holds marks back until Alt+C with Hide until done", async () => {
    const t = setup({ hide: true });
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 26", verdict: "incorrect" });
    t.write(line(100, 6, 0));
    await t.wait(1300);
    t.write(line(170, 4, 100));
    await t.wait(1300);
    const [held] = t.live.open;
    expect(held?.revealed).toBe(false);
    expect(useNotebookUi.getState().unrevealedMarks.has(held?.strokeGroupId ?? "")).toBe(true);
    expect(await t.live.reveal()).toBe(1);
    expect(t.live.open[0]?.revealed).toBe(true);
    expect(useNotebookUi.getState().unrevealedMarks.size).toBe(0);
  });

  it("takes a mark off for 'Not wrong' and keeps it as a correction", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 26", verdict: "incorrect" });
    t.write(line(100, 6, 0));
    await t.wait(1300);
    t.write(line(170, 4, 100));
    await t.wait(1300);
    const [mark] = t.live.open;
    await t.live.dismiss(mark?.id ?? "", "not_wrong");
    expect(t.live.open).toEqual([]);
    expect(t.marks()).toEqual([]);
    expect(t.saved.at(-1)).toMatchObject({ id: mark?.id, dismissedAs: "not_wrong" });
  });

  it("waits for a pause before drawing while the student keeps writing, and caps open marks", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    for (let i = 0; i < 8; i++)
      t.readings.set(170 + i * 70, { text: `3x = ${26 + i}`, verdict: "incorrect" });
    t.write(line(100, 6, 0));
    await t.wait(300);
    for (let i = 0; i < 8; i++) {
      t.write(line(170 + i * 70, 3, 100 + i * 10));
      await t.wait(200); // writing on: each new line finishes the one before
    }
    await t.wait(5_000);
    // Every line got its mark, but only six show; the rest wait (unseen) for room.
    const errors = t.live.open.filter((a) => a.markKind === "error");
    expect(errors).toHaveLength(8);
    expect(errors.filter((a) => a.revealed)).toHaveLength(6);
    const waiting = errors.filter((a) => !a.revealed).map((a) => a.strokeGroupId);
    expect([...useNotebookUi.getState().unrevealedMarks].sort()).toEqual(waiting.sort());
    // One taken off: the oldest waiting mark appears.
    await t.live.dismiss(errors[0]?.id ?? "", "hidden");
    expect(t.live.open.filter((a) => a.revealed)).toHaveLength(6);
  });

  it("finishes the line being written when the student moves to another page", async () => {
    const t = setup();
    t.readings.set(100, { text: "3x + 7 = 19" });
    t.readings.set(170, { text: "3x = 26", verdict: "incorrect" });
    t.write(line(100, 6, 0));
    await t.wait(1300);
    t.write(line(170, 4, 100));
    await t.wait(200); // still writing it: not finished yet
    expect(t.live.open).toEqual([]);
    const leaving = t.live.attach(null); // the next page
    await t.wait(1000);
    await leaving;
    expect(t.saved.some((a) => a.markKind === "error")).toBe(true);
    expect(t.marks().some((s) => s.markKind === "error")).toBe(true);
  });

  it("drops a notebook to Quiet for the day when the budget is spent", () => {
    const now = new Date("2026-10-26T15:00:00").getTime();
    useMarkPrefs.setState({
      byNotebook: { n1: { level: "coach", hideUntilDone: false } },
      quietUntil: 0,
    });
    expect(useMarkPrefs.getState().levelFor("n1", now)).toBe("coach");
    expect(useMarkPrefs.getState().budgetSpent(now)).toBe(true);
    expect(useMarkPrefs.getState().budgetSpent(now)).toBe(false);
    expect(useMarkPrefs.getState().levelFor("n1", now)).toBe("quiet");
    expect(useMarkPrefs.getState().levelFor("n1", new Date("2026-10-27T08:00:00").getTime())).toBe(
      "coach",
    );
  });
});
