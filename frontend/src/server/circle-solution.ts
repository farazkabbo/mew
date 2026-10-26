import "server-only";

import {
  checkedStep,
  CIRCLE_LIMITS,
  type CircleAskRequest,
  type CircleModelStep,
  circleStepReasons,
  type CircleStreamEvent,
  clipWords,
  type DestinationResolution,
  marksBox,
  questionText,
  SAFE_FALLBACK,
  SCREEN_LIMITS,
  type SolutionRequest,
  type Subject,
  type SolutionResponse,
  toSavedSolution,
  TUTOR_LIMITS,
  type TutorScreenAction,
  type VerifiedSolution,
} from "@mew/shared";

import { keepForEntry } from "./entry-extras";
import { ModelBusyError } from "./gemini";
import { solve } from "./solution";
import { unavailableMessage } from "./tutor";

/**
 * "Just tell me the answer" in Circle & Ask (K7, docs/NOTEBOOKS_K.md §6.2): what the student
 * circled is solved and verified exactly as in the notebook (K6, `solve`), then played on screen
 * as ordinary Circle & Ask steps (each step's work written beside the marks, its reason said),
 * ending with where the Your Turn waits. The verified solution waits for the entry to be saved
 * (`keepForEntry`): the clips route attaches it then, so it never passes through the device. Nothing unverified is shown: an uncertain solve says so, with no ink.
 */

/** Steps shown on screen: the work in up to four steps, then the answer (Circle & Ask's five). */
const WORK_STEPS = CIRCLE_LIMITS.maxSteps - 1;
export type CircleSolutionDeps = {
  solve: typeof solve;
  now: () => number;
  newTurnId: () => string;
};

const defaultDeps: CircleSolutionDeps = {
  solve,
  now: () => performance.now(),
  newTurnId: () => crypto.randomUUID(),
};

/** "Physics › Chapter 5", or null when the place isn't settled yet. */
export function placeLabel(resolution: DestinationResolution | null): string | null {
  if (resolution?.kind === "resolved") return resolution.destination.path.join(" › ");
  if (resolution?.kind === "missing")
    return [...resolution.parentPath, resolution.title].join(" › ");
  return null;
}

export async function* runCircleSolution(
  request: CircleAskRequest,
  context: {
    userId: string;
    place: string | null;
    /** Files the moment by its subject when nothing was said (K8): events to send before `done`. */
    file?: (subject: Subject) => Promise<readonly CircleStreamEvent[]>;
  },
  signal?: AbortSignal,
  deps: CircleSolutionDeps = defaultDeps,
): AsyncGenerator<CircleStreamEvent> {
  const started = deps.now();
  const elapsed = () => Math.round(deps.now() - started);
  let response: SolutionResponse;
  try {
    response = await deps.solve(solutionRequest(request), signal, undefined, {
      type: "image",
      base64: request.focus.image.jpeg,
      mimeType: "image/jpeg",
    });
  } catch (error) {
    if (signal?.aborted) return;
    if (error instanceof ModelBusyError) {
      yield { type: "error", message: unavailableMessage(error) };
      return;
    }
    console.warn("[circle] solution failed:", error instanceof Error ? error.name : "error");
    response = { type: "uncertain", speech: "I couldn't work that out just now. Try again." };
  }

  if (response.type !== "solution") {
    // Never a confident wrong answer: say what's uncertain, with no ink (§6.1 step 2).
    const say = response.type === "uncertain" ? response.speech : SAFE_FALLBACK.speech;
    const step = checkedStep({ actions: [], say }, 0, limitsOf(request));
    yield { type: "step", step, latencyMs: elapsed() };
    yield done(request, null, deps.newTurnId(), elapsed());
    return;
  }

  const solution = response.solution;
  // Filed first (nothing was said about where), so the last caption can say where it went.
  const filed = context.file ? await context.file(solution.subject).catch(() => []) : [];
  yield* filed;
  const filedTo = filed.find((e) => e.type === "destination");
  const place =
    context.place ?? placeLabel(filedTo?.type === "destination" ? filedTo.resolution : null);
  const steps = screenSteps(solution, marksBox(request.marks), place);
  for (const [index, modelStep] of steps.entries()) {
    const step = checkedStep(modelStep, index, limitsOf(request));
    const blocked = circleStepReasons(step);
    if (blocked.length > 0) {
      console.info(`[circle] safety check stopped a solution (${blocked.join(", ")})`);
      yield { type: "abort", speech: SAFE_FALLBACK.speech };
      return;
    }
    yield { type: "step", step, latencyMs: elapsed() };
  }
  keepForEntry(context.userId, request.sessionId, { solution: toSavedSolution(solution) });
  yield done(request, solution, deps.newTurnId(), elapsed());
}

/** What the solver is given: the question, and the circled words and the text around them. */
function solutionRequest(request: CircleAskRequest): SolutionRequest {
  const text = [...request.marks.map((m) => m.text), ...request.blocks.map((b) => b.text)]
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, TUTOR_LIMITS.clippedTextChars);
  const source = request.source?.title ?? request.app ?? "the screen";
  return {
    utterance: questionText(request.question) ?? "Just tell me the answer.",
    recognizedLines: [],
    pageImage: null,
    clippedText: text ? [{ source: source.slice(0, 200), text }] : [],
    courseContext: [],
    concepts: [],
    variantOf: null,
  };
}

/**
 * The solution as Circle & Ask steps: its work in at most four steps (more are grouped, never
 * dropped, so no algebra is skipped), each written beside the marks with its reasons said; then
 * the answer, and where the Your Turn is.
 */
export function screenSteps(
  solution: VerifiedSolution,
  beside: ReturnType<typeof marksBox>,
  place: string | null,
): CircleModelStep[] {
  const per = Math.ceil(solution.steps.length / WORK_STEPS);
  const groups: (typeof solution.steps)[] = [];
  for (let i = 0; i < solution.steps.length; i += per)
    groups.push(solution.steps.slice(i, i + per));
  const work = groups.map((group): CircleModelStep => {
    const actions: TutorScreenAction[] = group.flatMap((step): TutorScreenAction[] => [
      ...(step.figure ? [{ type: "sketch" as const, besideBox: beside, figure: step.figure }] : []),
      { type: "write_step", latexOrText: written(step.latex, step.work), besideBox: beside },
    ]);
    return { actions, say: group.map((s) => s.why).join(" ") };
  });
  const answer = solution.finalAnswer;
  const where = place ? `Your turn is in ${place}.` : "Your turn is waiting in your notebook.";
  const last: CircleModelStep = {
    actions: [
      { type: "write_step", latexOrText: written(answer.latex, answer.text), besideBox: beside },
    ],
    say: clipWords(
      `So the answer is ${answer.text}.${solution.yourTurnVerified ? ` ${where}` : ""}`,
      CIRCLE_LIMITS.sayWords,
    ),
  };
  return [...work, last];
}

/** The LaTeX when it fits a screen step, else the words (cut to fit). */
function written(latex: string | null, words: string): string {
  if (latex && latex.length <= SCREEN_LIMITS.stepChars) return latex;
  return words.slice(0, SCREEN_LIMITS.stepChars);
}

function limitsOf(request: CircleAskRequest) {
  return {
    marks: marksBox(request.marks),
    widthPx: request.focus.widthPx,
    heightPx: request.focus.heightPx,
  };
}

function done(
  request: CircleAskRequest,
  solution: VerifiedSolution | null,
  turnId: string,
  latencyMs: number,
): CircleStreamEvent {
  const problem = solution?.problem.text ?? questionText(request.question) ?? "Explain this";
  return {
    type: "done",
    turnId,
    readQuestion: problem.slice(0, CIRCLE_LIMITS.questionChars),
    summary: (solution
      ? `Worked solution: ${solution.finalAnswer.text}.`
      : "Not solved: the answer couldn't be checked."
    ).slice(0, CIRCLE_LIMITS.summaryChars),
    followUpQuestion:
      solution?.yourTurnVerified === true
        ? `Your turn: ${solution.yourTurn.problem}`.slice(0, CIRCLE_LIMITS.followUpChars)
        : null,
    conceptHints: [],
    latencyMs,
  };
}
