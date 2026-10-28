import {
  HANDWRITING_LIMITS,
  type HandwritingProfileSummary,
  HandwritingProfileSummary as SummarySchema,
  type HandwritingSampleInput,
} from "@mew/shared";

/** The student's handwriting profile (K10 §8.3), through the app's own routes. */
export const handwritingApi = {
  async summary(): Promise<HandwritingProfileSummary> {
    const response = await fetch("/api/handwriting/samples", { cache: "no-store" });
    if (!response.ok) throw new Error(`Couldn't load (${response.status})`);
    return SummarySchema.parse(await response.json());
  },

  /** Sends samples (in batches the server takes). Resolves with how many were kept. */
  async add(samples: readonly HandwritingSampleInput[]): Promise<number> {
    let saved = 0;
    for (let i = 0; i < samples.length; i += HANDWRITING_LIMITS.samplesPerRequest) {
      const response = await fetch("/api/handwriting/samples", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          samples: samples.slice(i, i + HANDWRITING_LIMITS.samplesPerRequest),
        }),
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`Couldn't save (${response.status})`);
      saved += ((await response.json()) as { saved: number }).saved;
    }
    return saved;
  },

  /** Reset: everything neb learned about this student's handwriting is deleted. */
  async reset(): Promise<void> {
    const response = await fetch("/api/handwriting/samples", { method: "DELETE" });
    if (!response.ok) throw new Error(`Couldn't reset (${response.status})`);
  },
};
