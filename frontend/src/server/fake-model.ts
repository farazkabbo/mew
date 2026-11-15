import "server-only";

/**
 * A stand-in for Gemini and ElevenLabs on preview and staging deploys (docs/LAUNCH_LIMITS.md):
 * the journey test and the load test exercise everything around the model (auth, the gate,
 * Redis, Postgres) without spending anything. On only with NEB_FAKE_MODEL=1 on a deploy that
 * isn't production: next.config.ts refuses to build production with it, and this checks again
 * at run time.
 *
 * Its answers are fixed and valid for the real schemas. A question containing "FAKE_FAIL" fails
 * before anything is said, to try the refund.
 */

export function isProductionDeploy(): boolean {
  return process.env.VERCEL_ENV === "production" || process.env.NEB_DEPLOY_ENV === "production";
}

export function fakeModel(): boolean {
  return process.env.NEB_FAKE_MODEL === "1" && !isProductionDeploy();
}

export class FakeModelFailure extends Error {
  override readonly name = "FakeModelFailure";
}

const ANSWERS: Record<string, unknown> = {
  "screen-intent": { intent: "ask" },
  "screen-act": { speech: "That's done.", action: { type: "done" } },
  "screen-write": {
    speech: "Here's a sentence to start with.",
    kind: "insert",
    text: "Cats sleep for most of the day, and hunt at dusk.",
  },
  "screen-ask": {
    speech: "That's the Insert tab. Have a look for PivotTable there.",
    actions: [],
    mode: "answer",
  },
  "circle-ask": {
    readQuestion: "Explain this",
    steps: [
      { actions: [], say: "Start by undoing the plus: take 7 from both sides." },
      { actions: [], say: "Then share what's left by 3. What do you get?" },
    ],
    summary: "Undo each step in reverse order.",
    followUpQuestion: "What would you do first with 2x − 5 = 9?",
    conceptHints: ["linear equations"],
    subject: "math",
    checkQuestion: null,
  },
  tutor: { speech: "Good start. What happens if you take 7 from both sides?", actions: [] },
};

/** The fixed answer for `purpose`, as the model's raw JSON text. */
export function fakeAnswer(purpose: string, input: unknown): string {
  if (JSON.stringify(input ?? "").includes("FAKE_FAIL")) {
    throw new FakeModelFailure("the fake model failed on purpose");
  }
  const answer = ANSWERS[purpose];
  if (!answer) throw new FakeModelFailure(`the fake model has no answer for ${purpose}`);
  return JSON.stringify(answer);
}

/** Half a second of silence, as the speech stream's 16-bit PCM. */
export function fakeSpeech(sampleRate: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(sampleRate));
      controller.close();
    },
  });
}
