import { type Line, PageDocument, segmentLines, strokeBBox } from "@mew/ink";
import type { LineCheck, MewDecisionResponse, Point, Recognition, Stroke } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MewController } from "../mew/controller";
import { useMew } from "../mew/store";
import type { Clock } from "../mew/triggers";
import type { PageChange } from "../notebook/engine";
import type { RecognitionService } from "../tutor/recognition";
import { useVoice } from "../voice/store";
import { WorkChecker } from "./checker";
import { derivationLines } from "./lines";

let created = 0;

/** A line of `n` letter-strokes at height y. */
function writeLine(y: number, n = 4): Stroke[] {
  return Array.from({ length: n }, (_, i) => {
    const points: Point[] = [
      [40 + i * 26, y + 22, 0.5, 0],
      [52 + i * 26, y, 0.5, 20],
      [64 + i * 26, y + 22, 0.5, 40],
    ];
    return {
      id: crypto.randomUUID(),
      pageId: "00000000-0000-4000-8000-000000000001",
      author: "student" as const,
      tool: "pen" as const,
      points,
      color: "#1d1c1a",
      width: 3,
      bbox: strokeBBox(points, 3),
      createdAt: ++created,
    };
  });
}

/** Recognition answers keyed by the line's position (0 = top line). */
function fakeRecognition(doc: PageDocument, answers: Partial<Recognition>[]) {
  const top = (line: Line) => {
    const ordered = segmentLines(doc.all()).sort((a, b) => a.bbox[1] - b.bbox[1]);
    return ordered.findIndex((l) => l.id === line.id);
  };
  const answer = (line: Line): Recognition | null => {
    const a = answers[top(line)];
    return a ? { text: "", latex: null, subject: "math", confidence: 0.9, ...a } : null;
  };
  return {
    cached: (_doc: PageDocument, line: Line) => answer(line) ?? undefined,
    recognize: (_doc: PageDocument, line: Line) => Promise.resolve(answer(line)),
  } as unknown as RecognitionService;
}

function mathApi(results: unknown[]) {
  return vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(Response.json({ results })),
  );
}

describe("derivationLines", () => {
  it("collects the working above the target, stopping at a new problem", () => {
    const strokes = [...writeLine(0), ...writeLine(300), ...writeLine(340), ...writeLine(380)];
    const lines = segmentLines(strokes).sort((a, b) => a.bbox[1] - b.bbox[1]);
    const chain = derivationLines(lines, lines[3] as Line);
    expect(chain.map((l) => l.id)).toEqual(lines.slice(1).map((l) => l.id));
  });
});

describe("WorkChecker", () => {
  const twoLines = () => new PageDocument([...writeLine(100), ...writeLine(140)]);

  it("sends maths working to SymPy and labels the line being checked", async () => {
    const doc = twoLines();
    const fetchImpl = mathApi([
      { index: 0, verdict: "unknown", reason: "first_line", detail: null },
      {
        index: 1,
        verdict: "incorrect",
        reason: "changes_solutions",
        detail: "x = 2 before, x = 5 after",
      },
    ]);
    const checker = new WorkChecker({
      recognition: fakeRecognition(doc, [{ latex: "2x+3=7" }, { latex: "2x=10" }]),
      fetchImpl,
    });

    const checks = await checker.check(doc);

    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      steps: ["2x+3=7", "2x=10"],
    });
    expect(checks).toEqual([
      expect.objectContaining({
        checker: "math",
        verdict: "incorrect",
        target: true,
        detail: "x = 2 before, x = 5 after",
      }),
    ]);
  });

  it("balance-checks chemistry locally, with no network call", async () => {
    const doc = new PageDocument(writeLine(100));
    const fetchImpl = mathApi([]);
    const checker = new WorkChecker({
      recognition: fakeRecognition(doc, [
        { latex: "H_2 + O_2 \\rightarrow H_2O", subject: "chemistry" },
      ]),
      fetchImpl,
    });
    const [check] = await checker.check(doc);
    expect(check).toMatchObject({
      checker: "chemistry",
      verdict: "incorrect",
      reason: "unbalanced",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports code that fails to run, and leaves prose to the tutor's rubric", async () => {
    const doc = new PageDocument(writeLine(100));
    const code = {
      run: vi.fn(() => Promise.resolve({ ok: false, output: "", error: "NameError: x" })),
    };
    const coding = new WorkChecker({
      recognition: fakeRecognition(doc, [{ text: "print(x)", subject: "programming" }]),
      code,
    });
    expect(await coding.check(doc)).toEqual([
      expect.objectContaining({ checker: "code", verdict: "incorrect", detail: "NameError: x" }),
    ]);

    const essay = new WorkChecker({
      recognition: fakeRecognition(doc, [{ text: "The war began in 1914", subject: "history" }]),
    });
    expect(await essay.check(doc)).toEqual([]);
  });

  it("quick-checks each version of a line once, and only reports definite verdicts", async () => {
    const doc = twoLines();
    const fetchImpl = mathApi([
      { index: 0, verdict: "unknown", reason: "first_line" },
      { index: 1, verdict: "correct", reason: "equivalent" },
    ]);
    const checker = new WorkChecker({
      recognition: fakeRecognition(doc, [{ latex: "2x+3=7" }, { latex: "2x=4" }]),
      fetchImpl,
    });
    expect(await checker.quickCheck(doc)).toHaveLength(1);
    expect(await checker.quickCheck(doc)).toBeNull(); // same strokes: already ticked

    const unsure = new WorkChecker({
      recognition: fakeRecognition(doc, [{ latex: "2x+3=7" }, { latex: "2x=4" }]),
      fetchImpl: mathApi([{ index: 1, verdict: "unknown", reason: "undecided" }]),
    });
    expect(await unsure.quickCheck(doc)).toBeNull();
  });

  it("stays quiet while the checker service is down, then tries again later", async () => {
    const doc = twoLines();
    let now = 0;
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 503 })));
    const checker = new WorkChecker({
      recognition: fakeRecognition(doc, [{ latex: "x=1" }, { latex: "x=1" }]),
      fetchImpl,
      now: () => now,
    });
    expect(await checker.check(doc)).toEqual([]);
    expect(await checker.check(doc)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledOnce(); // paused, not hammered
    now += 31_000;
    await checker.check(doc);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // a starting service gets another chance
  });
});

describe("MewController with a quick check", () => {
  const timers: (() => void)[] = [];
  const clock: Clock = {
    now: () => 5_000_000,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => undefined,
  };
  const ignore: MewDecisionResponse = {
    output: { label: "ignore", confidence: 0.9, reason: "pause" },
    source: "model",
    latencyMs: 100,
  };

  beforeEach(() => {
    timers.length = 0;
    useMew.setState({ decisions: [], pending: 0, threshold: 0.7 });
    useVoice.setState({ segments: [], partial: "" });
  });

  function pausedPage(quick: LineCheck[] | null) {
    const listeners = new Set<(c: PageChange) => void>();
    const gate = { decide: vi.fn(() => Promise.resolve(ignore)) };
    const hooks = {
      quickCheck: vi.fn(() => Promise.resolve(quick)),
      onRespond: vi.fn(),
      onVerifiedCorrect: vi.fn(),
    };
    const mew = new MewController(gate, clock, hooks);
    mew.observe({
      doc: new PageDocument(writeLine(100)),
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    });
    for (let i = 0; i < 3; i++) listeners.forEach((l) => l("draw"));
    timers.forEach((fire) => fire()); // the pen rests
    return { gate, hooks };
  }

  const verdict = (v: LineCheck["verdict"]): LineCheck[] => [
    { lineId: "line_a", checker: "math", verdict: v, reason: "x", target: true },
  ];
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("ticks a verified-correct line without asking the gate or the tutor", async () => {
    const { gate, hooks } = pausedPage(verdict("correct"));
    await settle();
    expect(hooks.onVerifiedCorrect).toHaveBeenCalledWith(verdict("correct"));
    expect(hooks.onRespond).not.toHaveBeenCalled();
    expect(gate.decide).not.toHaveBeenCalled();
    expect(useMew.getState().decisions[0]).toMatchObject({ source: "checker", acted: true });
  });

  it("hands a verified mistake to the tutor with the verdict", async () => {
    const { gate, hooks } = pausedPage(verdict("incorrect"));
    await settle();
    expect(hooks.onRespond).toHaveBeenCalledWith(
      expect.objectContaining({ intent: "check_work", checks: verdict("incorrect") }),
    );
    expect(gate.decide).not.toHaveBeenCalled();
  });

  it("falls back to the gate when the checker can't tell", async () => {
    const { gate, hooks } = pausedPage(null);
    await settle();
    expect(gate.decide).toHaveBeenCalledOnce();
    expect(hooks.onRespond).not.toHaveBeenCalled();
  });
});
