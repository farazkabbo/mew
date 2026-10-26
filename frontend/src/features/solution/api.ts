import {
  MathCheckResponse,
  type SolutionConcept,
  type SolutionRequest,
  SolutionResponse,
} from "@mew/shared";
import type { z } from "zod";

/** `POST /api/solution`: a verified worked solution, a Your Turn, or "uncertain". */
export async function requestSolution(
  request: SolutionRequest,
  signal?: AbortSignal,
): Promise<SolutionResponse> {
  const response = await fetch("/api/solution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    cache: "no-store",
    ...(signal && { signal }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    throw new Error(
      typeof body?.error === "string"
        ? body.error
        : "I couldn't work that out just now — try again in a moment.",
    );
  }
  return SolutionResponse.parse(await response.json());
}

/** SymPy on the API service, through `/api/check/math`; null when it can't be reached. */
export async function checkMathSteps(
  steps: string[],
): Promise<MathCheckResponse["results"] | null> {
  try {
    const response = await fetch("/api/check/math", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps }),
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;
    return MathCheckResponse.parse(await response.json()).results;
  } catch {
    return null;
  }
}

/** A course's concepts as the Your Turn may name them (ids checked by the server too). */
export function conceptsOf(detail: {
  concepts: readonly { id: string; title: string }[];
}): z.infer<typeof SolutionConcept>[] {
  return detail.concepts.slice(0, 40).map((c) => ({ id: c.id, title: c.title.slice(0, 120) }));
}
