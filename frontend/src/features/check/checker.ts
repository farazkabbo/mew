import { currentLine, type Line, type PageDocument, strokeGroupHash } from "@mew/ink";
import {
  checkBalance,
  type LineCheck,
  looksLikeReaction,
  MathCheckResponse,
  type Recognition,
} from "@mew/shared";

import { strokesOf, studentLines } from "../notebook/export-line";
import type { RecognitionService } from "../tutor/recognition";
import { derivationLines } from "./lines";

/** How long a check waits for handwriting recognition of the lines involved. */
const RECOGNITION_WAIT_MS = 4000;
/** How long maths checks pause after the service reports it is unavailable. */
const MATH_RETRY_MS = 30_000;
const MATH_SUBJECTS = new Set<Recognition["subject"]>(["math", "physics"]);

/** A snippet's run: its output, and on failure the error and the line it failed on (1-based). */
export type CodeRun = {
  ok: boolean;
  output: string;
  error?: string | undefined;
  line?: number | undefined;
};

/** Runs code and reports whether it failed (Pyodide in a worker; optional). */
export type CodeRunner = {
  run(code: string): Promise<CodeRun>;
};

export type CheckDeps = {
  recognition: RecognitionService;
  code?: CodeRunner | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/**
 * The checker router (brief §7): picks a verifier for the line being worked on from its subject
 * and content — SymPy for maths and physics (on the API service), atom/charge balance for
 * chemistry, a sandboxed run for code — and returns verified verdicts. Everything else is left
 * to the tutor's rubric. It never guesses: undecidable lines come back "unknown" or not at all.
 */
export class WorkChecker {
  private readonly fetchImpl: typeof fetch;
  /** Lines (by exact strokes) already handled by a quiet check, so a tick isn't drawn twice. */
  private readonly handled = new Set<string>();
  /** After a 503 (service down or starting), maths checks pause until this time. */
  private mathPausedUntil = 0;
  private readonly now: () => number;

  constructor(private readonly deps: CheckDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((...args) => fetch(...args));
    this.now = deps.now ?? Date.now;
  }

  /** Verdicts about the current line (the target) and the working that leads to it. */
  async check(doc: PageDocument, target?: Line): Promise<LineCheck[]> {
    const lines = studentLines(doc);
    const line = target ?? currentLine(lines);
    if (!line) return [];
    const chain = derivationLines(lines, line);
    const recognitions = await Promise.all(chain.map((l) => this.recognise(doc, l)));
    const subject = recognitions.at(-1)?.subject;
    const texts = recognitions.map((r) => (r ? (r.latex ?? r.text).trim() : ""));

    if (subject === "chemistry" || looksLikeReaction(texts.at(-1) ?? "")) {
      return this.chemistry(chain, texts, line);
    }
    if (subject === "programming") return this.code(line, texts.at(-1) ?? "");
    if (subject && MATH_SUBJECTS.has(subject)) return this.math(chain, texts, line);
    return [];
  }

  /**
   * A check after a writing pause: returns verdicts only the first time this exact line is
   * checked, so editing elsewhere doesn't redraw the same tick.
   */
  async quickCheck(doc: PageDocument): Promise<LineCheck[] | null> {
    const line = currentLine(studentLines(doc));
    if (!line) return null;
    const key = strokeGroupHash(strokesOf(doc, [line]));
    if (this.handled.has(key)) return null;
    const checks = await this.check(doc, line);
    const verdict = checks.find((c) => c.target)?.verdict;
    if (verdict !== "correct" && verdict !== "incorrect") return null;
    this.handled.add(key);
    return checks;
  }

  private async math(chain: Line[], texts: string[], target: Line): Promise<LineCheck[]> {
    // Only the unbroken run of readable lines ending at the target can be checked as steps.
    let start = texts.length - 1;
    while (start > 0 && texts[start - 1]) start--;
    const steps = texts.slice(start);
    if (this.now() < this.mathPausedUntil || !steps.at(-1)) return [];
    let results: MathCheckResponse["results"];
    try {
      const response = await this.fetchImpl("/api/check/math", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ steps }),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      });
      if (response.status === 503) this.mathPausedUntil = this.now() + MATH_RETRY_MS;
      if (!response.ok) return [];
      results = MathCheckResponse.parse(await response.json()).results;
    } catch {
      return [];
    }
    const lines = chain.slice(start);
    return results.flatMap((r) => {
      const line = lines[r.index];
      if (!line || r.reason === "first_line") return [];
      return [
        {
          lineId: line.id,
          checker: "math" as const,
          verdict: r.verdict,
          reason: r.reason,
          detail: r.detail ?? null,
          target: line.id === target.id,
        },
      ];
    });
  }

  private chemistry(chain: Line[], texts: string[], target: Line): LineCheck[] {
    return chain.flatMap((line, i) => {
      const text = texts[i] ?? "";
      if (!looksLikeReaction(text)) return [];
      const result = checkBalance(text);
      return [
        {
          lineId: line.id,
          checker: "chemistry" as const,
          verdict: result.verdict,
          reason: result.reason,
          detail: result.verdict === "incorrect" ? result.detail : null,
          target: line.id === target.id,
        },
      ];
    });
  }

  private async code(target: Line, source: string): Promise<LineCheck[]> {
    if (!this.deps.code || !source) return [];
    try {
      const run = await this.deps.code.run(source);
      // A clean run proves little (no expected output), so only failures are verdicts.
      return [
        {
          lineId: target.id,
          checker: "code",
          verdict: run.ok ? "unknown" : "incorrect",
          reason: run.ok ? "ran" : "error",
          detail: (run.error ?? run.output).slice(0, 300) || null,
          target: true,
        },
      ];
    } catch {
      return [];
    }
  }

  private async recognise(doc: PageDocument, line: Line): Promise<Recognition | null> {
    const known = this.deps.recognition.cached(doc, line);
    if (known) return known;
    return Promise.race([
      this.deps.recognition.recognize(doc, line),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), RECOGNITION_WAIT_MS)),
    ]);
  }
}
