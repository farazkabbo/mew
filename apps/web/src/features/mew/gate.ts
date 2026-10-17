import {
  fallbackMew,
  MewDecisionResponse,
  type MewDecisionResponse as Decision,
  type MewInput,
  prefilterMew,
} from "@mew/shared";

/** Decides whether the tutor should respond. v1 asks the server; v2 will run in the browser. */
export interface MewGate {
  decide(input: MewInput): Promise<Decision>;
}

const REQUEST_TIMEOUT_MS = 4000;

/** Mew v1: obvious cases are decided locally; the rest by the gate model behind `/api/mew`. */
export class HttpMewGate implements MewGate {
  constructor(private readonly fetchImpl: typeof fetch = (...args) => fetch(...args)) {}

  async decide(input: MewInput): Promise<Decision> {
    const rule = prefilterMew(input);
    if (rule) return { output: rule, source: "rule", latencyMs: 0 };

    const started = performance.now();
    try {
      const response = await this.fetchImpl("/api/mew", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`gate responded ${response.status}`);
      return MewDecisionResponse.parse(await response.json());
    } catch (error) {
      console.warn("[mew] gate request failed:", error instanceof Error ? error.message : error);
      return {
        output: fallbackMew(input),
        source: "fallback",
        latencyMs: Math.round(performance.now() - started),
      };
    }
  }
}
