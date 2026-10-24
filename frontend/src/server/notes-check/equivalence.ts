import "server-only";

import { z } from "zod";

import { apiFetch } from "../api-client";
import type { MathVerdict } from "./compare";

const Verdicts = z.object({ verdicts: z.array(z.enum(["equivalent", "different", "unknown"])) });

/** SymPy on maths claims (stateless; the internal secret is all it needs). */
export async function checkEquivalence(
  pairs: { note: string; screen: string }[],
): Promise<MathVerdict[]> {
  const { verdicts } = await apiFetch("/v1/notes/equivalence", Verdicts, {
    method: "POST",
    body: { pairs },
    timeoutMs: 6_000,
  });
  return verdicts;
}
