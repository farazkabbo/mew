/**
 * Tokens per question against the real model: `pnpm eval:tokens` (needs GEMINI_API_KEY). Three
 * scripted turns (docs/PLAN.md, Part 4): circle a maths line and ask "explain", circle a paragraph
 * and ask "what does this mean", and a general question that doesn't need the screen. Prints the
 * input, cached, output and thinking tokens each turn used, as the API reported them.
 * Runs under `--conditions=react-server` so server-only modules load outside Next.js.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { CircleAskRequest, ScreenAskRequest } from "@mew/shared";

const ROOT_ENV = path.resolve(import.meta.dirname, "../../.env.local");
if (existsSync(ROOT_ENV)) process.loadEnvFile(ROOT_ENV);
if (!process.env.GEMINI_API_KEY) {
  console.log("eval:tokens skipped — set GEMINI_API_KEY in .env.local.");
  process.exit(0);
}

const { onUsage } = await import("../src/server/gemini");
const { runCircleAsk } = await import("../src/server/circle-ask");
const { runScreenTutor } = await import("../src/server/screen-tutor");

const jpeg = (name: string) =>
  readFileSync(path.join(import.meta.dirname, "tokens", `${name}.jpg`)).toString("base64");

function circle(name: string, question: string, text: string, size: [number, number]) {
  return {
    sessionId: crypto.randomUUID(),
    question: { source: "voice", text: question },
    marks: [
      {
        number: 1,
        kind: "circle",
        box: { left: 60, top: 80, right: 940, bottom: 920 },
        polygon: [],
        text,
      },
    ],
    focus: {
      image: { jpeg: jpeg(`${name}-focus`), width: size[0], height: size[1] },
      widthPx: size[0],
      heightPx: size[1],
    },
    context: { jpeg: jpeg(`${name}-context`), width: 1600, height: 900 },
    blocks: [{ id: "b1", text, box: { left: 60, top: 80, right: 940, bottom: 920 } }],
    app: "msedge.exe",
    kind: "browser",
    history: [],
  } satisfies CircleAskRequest;
}

const TURNS: { name: string; run: () => AsyncIterable<unknown> }[] = [
  {
    name: 'circle a maths line, "explain"',
    run: () => runCircleAsk(circle("maths", "explain", "3x + 7 = 19", [560, 120])),
  },
  {
    name: 'circle a paragraph, "what does this mean"',
    run: () =>
      runCircleAsk(
        circle(
          "paragraph",
          "what does this mean",
          "As the vapour rises it cools and condenses into tiny droplets, forming clouds. This process, called condensation, releases latent heat into the surrounding air, which can drive further convection.",
          [1150, 140],
        ),
      ),
  },
  {
    name: "a general question (no screen needed)",
    run: () =>
      runScreenTutor({
        transcript: "what's the difference between weather and climate?",
        app: "msedge.exe",
        scope: "window",
        image: { jpeg: jpeg("paragraph-context"), width: 1600, height: 900 },
      } satisfies ScreenAskRequest),
  },
];

const rows: string[] = [];
for (const turn of TURNS) {
  const totals = { input: 0, cached: 0, output: 0, thought: 0, calls: 0 };
  const stop = onUsage((usage) => {
    totals.input += usage.input;
    totals.cached += usage.cached;
    totals.output += usage.output;
    totals.thought += usage.thought;
    totals.calls += 1;
  });
  const said: string[] = [];
  for await (const event of turn.run()) {
    // Played out in full: the usage arrives with the last event. What it said, to check by eye.
    const e = event as { type?: string; text?: string; step?: { say?: string } };
    if (e.type === "speech" && e.text) said.push(e.text);
    if (e.type === "step" && e.step?.say) said.push(e.step.say);
  }
  console.log(`${turn.name}: ${said.join(" / ")}`);
  stop();
  rows.push(
    `| ${turn.name} | ${totals.input} | ${totals.cached} | ${totals.output} | ${totals.thought} | ${totals.calls} |`,
  );
}
console.log("| Turn | Input | Cached | Output | Thinking | Calls |\n|---|---|---|---|---|---|");
console.log(rows.join("\n"));
