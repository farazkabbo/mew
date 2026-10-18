/**
 * Mew gate evaluation against the real model: `pnpm eval:mew` (needs GEMINI_API_KEY).
 * Fails if an acceptance case is wrong or overall accuracy drops below the bar.
 * Runs under `--conditions=react-server` so server-only modules load outside Next.js.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { MewInput, type MewLabel } from "@mew/shared";

const ROOT_ENV = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

const MIN_ACCURACY = 0.85;
/** Requests per minute (Gemini's free tier allows 15 for Flash-Lite). `EVAL_RPM=0` disables pacing. */
const RPM = Number(process.env.EVAL_RPM ?? 14);
const PACE_MS = RPM > 0 ? Math.ceil(60_000 / RPM) : 0;

type Case = {
  utterance: string;
  trigger?: MewInput["trigger"];
  signals?: Partial<MewInput["notebookSignals"]>;
  expect?: MewLabel;
  expectAnyOf?: MewLabel[];
  acceptance?: boolean;
};

if (!process.env.GEMINI_API_KEY) {
  console.log("eval:mew skipped — set GEMINI_API_KEY in .env.local to run it against the model.");
  process.exit(0);
}

const { classifyMew } = await import("../src/server/mew-gate");
const cases = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "mew.cases.json"), "utf8"),
) as Case[];

let correct = 0;
let acceptanceFailures = 0;
const latencies: number[] = [];

let lastCall = 0;
for (const c of cases) {
  const trigger = c.trigger ?? "utterance";
  const wait = lastCall + PACE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastCall = Date.now();
  const input = MewInput.parse({
    trigger,
    lastUtterance: c.utterance,
    recentTranscript: [],
    notebookSignals: {
      msSinceLastStroke: null,
      justErased: false,
      linesWrittenLast60s: 0,
      ...c.signals,
    },
    tutorSpokeRecently: false,
    explicitSummon: trigger === "summon",
  });
  const decision = await classifyMew(input);
  const allowed = c.expectAnyOf ?? (c.expect ? [c.expect] : []);
  const ok = allowed.includes(decision.output.label);
  if (ok) correct++;
  if (!ok && c.acceptance) acceptanceFailures++;
  if (decision.source === "model") latencies.push(decision.latencyMs);
  console.log(
    `${ok ? "✔" : "✘"} ${c.acceptance ? "[acceptance] " : ""}${JSON.stringify(c.utterance || `(${trigger})`)} → ` +
      `${decision.output.label} ${decision.output.confidence.toFixed(2)} (${decision.source}, ${decision.latencyMs} ms)` +
      (ok ? "" : `  expected ${allowed.join(" | ")}`),
  );
}

const accuracy = correct / cases.length;
const sorted = [...latencies].sort((a, b) => a - b);
const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
console.log(
  `\naccuracy ${(accuracy * 100).toFixed(1)}% (${correct}/${cases.length}) · model latency p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms`,
);

if (acceptanceFailures > 0 || accuracy < MIN_ACCURACY) {
  console.error(
    acceptanceFailures > 0
      ? "FAILED: acceptance case(s) misclassified"
      : "FAILED: accuracy below bar",
  );
  process.exitCode = 1;
}
