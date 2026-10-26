/**
 * M7 acceptance against the real tutor model: `pnpm eval:course` (needs GEMINI_API_KEY).
 * Given passages from a course (as retrieval supplies them), the tutor's answers must cite the
 * page the answer is on. Runs under `--conditions=react-server` so server-only modules load.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import type { CourseExcerpt, TutorRequest } from "@mew/shared";

const ROOT_ENV = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);

if (!process.env.GEMINI_API_KEY) {
  console.log("eval:course skipped — set GEMINI_API_KEY in .env.local.");
  process.exit(0);
}

const { runTutor } = await import("../src/server/tutor");

const COURSE: CourseExcerpt[] = [
  {
    page: 3,
    heading: "3.3 Friction",
    text: "Friction is a force that opposes sliding between surfaces in contact. Static friction stops an object starting to move; kinetic friction slows it down. The friction force depends on the normal force and the roughness of the surfaces.",
    source: "Forces and motion",
  },
  {
    page: 2,
    heading: "3.2 Newton's laws",
    text: "Newton's second law relates force, mass and acceleration: F = m a. Newton's third law: every action has an equal and opposite reaction.",
    source: "Forces and motion",
  },
];

const CASES: { question: string; page: number; context: CourseExcerpt[] }[] = [
  { question: "why does a sliding box slow down?", page: 3, context: COURSE },
  {
    question: "what does F = m a actually say?",
    page: 2,
    context: [COURSE[1], COURSE[0]] as CourseExcerpt[],
  },
];

function request(question: string, context: CourseExcerpt[]): TutorRequest {
  return {
    intent: "answer_question",
    lastUtterance: question,
    recentTranscript: [],
    pageImage: null,
    recognizedLines: [],
    answerStyle: "direct",
    depth: "normal",
    previousTutorSpeech: [],
    checks: [],
    courseContext: context,
    quiz: null,
    clippedText: [],
    circled: false,
    circledText: null,
  };
}

/** "page 3", "page three", "p. 3", "p.3" */
function cites(text: string, page: number): boolean {
  const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
  return new RegExp(`\\b(page|p\\.)\\s*(${page}|${words[page] ?? page})\\b`, "i").test(text);
}

let passed = 0;
for (const c of CASES) {
  let said = "";
  let written = "";
  for await (const event of runTutor(request(c.question, c.context))) {
    if (event.type === "response") {
      said = event.response.speech;
      written = JSON.stringify(event.response.actions);
    } else if (event.type === "error") {
      said = `(error: ${event.message})`;
    }
  }
  const ok = cites(said, c.page) || cites(written, c.page);
  if (ok) passed++;
  console.log(`${ok ? "✔" : "✘"} ${JSON.stringify(c.question)} → expects p. ${c.page}\n   ${said}`);
}
console.log(`\n${passed}/${CASES.length} answers cite the right page`);
if (passed < CASES.length) process.exitCode = 1;
