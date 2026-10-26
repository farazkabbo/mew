/**
 * M3 acceptance against the real services: `pnpm eval:tutor` (needs GEMINI_API_KEY,
 * ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID). For a few questions it measures, server-side,
 * the time from "question finished" to the first byte of spoken audio, and checks the replies
 * are short. Fails if the median exceeds the budget.
 * Runs under `--conditions=react-server` so server-only modules load outside Next.js.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import type { TutorRequest } from "@mew/shared";

const ROOT_ENV = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

/** Brief: first audio within ~1.5 s of the end of a question; "under ~2 s" for M3. */
const BUDGET_MS = 2000;

const required = ["GEMINI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  console.log(`eval:tutor skipped — set ${missing.join(", ")} in .env.local.`);
  process.exit(0);
}

const { runTutor } = await import("../src/server/tutor");
const { streamSpeech } = await import("../src/server/elevenlabs");

const QUESTIONS = [
  "why does the force cancel out?",
  "what's the difference between mitosis and meiosis?",
  "I'm stuck on how to start this one",
  "is two x plus three equals seven the same as x equals two?",
];

function request(question: string): TutorRequest {
  return {
    intent: question.includes("stuck") ? "give_hint" : "answer_question",
    lastUtterance: question,
    recentTranscript: [],
    pageImage: null,
    recognizedLines: [],
    answerStyle: "hints_first",
    depth: "normal",
    previousTutorSpeech: [],
    checks: [],
    courseContext: [],
    quiz: null,
    clippedText: [],
    circled: false,
    circledText: null,
  };
}

const firstAudio: number[] = [];
for (const question of QUESTIONS) {
  const started = performance.now();
  let speechMs = 0;
  let audioMs = 0;
  let speech = "";
  for await (const event of runTutor(request(question))) {
    if (event.type === "speech") {
      speech = event.text;
      speechMs = Math.round(performance.now() - started);
      try {
        const audio = await streamSpeech(speech, AbortSignal.timeout(15_000));
        const reader = audio.getReader();
        await reader.read();
        audioMs = Math.round(performance.now() - started);
        await reader.cancel();
      } catch (error) {
        // e.g. 402 on a free plan with a Voice Library voice: the server log above has the status.
        console.error(`✘ speech failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (event.type === "error") {
      console.error(`✘ ${JSON.stringify(question)}: ${event.message}`);
    }
  }
  if (audioMs > 0) firstAudio.push(audioMs);
  const sentences = speech.split(/[.!?]+\s/).filter(Boolean).length;
  console.log(
    `${audioMs > 0 && audioMs <= BUDGET_MS ? "✔" : "✘"} ${JSON.stringify(question)}\n` +
      `   speech ${speechMs} ms · first audio ${audioMs} ms · ${sentences} sentence(s): ${speech}`,
  );
}

const sorted = [...firstAudio].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] ?? Infinity;
console.log(
  `\nfirst audio median ${median} ms (budget ${BUDGET_MS} ms, ${firstAudio.length}/${QUESTIONS.length} answered)`,
);
if (median > BUDGET_MS || firstAudio.length < QUESTIONS.length) {
  console.error("FAILED");
  process.exitCode = 1;
}
