import { MewOutput } from "@mew/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    interactions = { create };
  },
}));

const request = {
  model: "gemini-test",
  system: "system",
  input: "input",
  schema: MewOutput,
  thinkingLevel: "minimal" as const,
  maxOutputTokens: 64,
  timeoutMs: 1000,
};

describe("generateStructured", () => {
  beforeEach(() => {
    vi.resetModules();
    create.mockReset();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
  });

  it("returns validated output and never asks the API to store the interaction", async () => {
    create.mockResolvedValue({
      output_text: '{"label":"ignore","confidence":0.9,"reason":"filler"}',
    });
    const { generateStructured } = await import("./gemini");

    await expect(generateStructured(request)).resolves.toEqual({
      label: "ignore",
      confidence: 0.9,
      reason: "filler",
    });
    const [params, options] = create.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(params.store).toBe(false);
    expect(params.model).toBe("gemini-test");
    expect(options.timeout_ms).toBe(1000);
  });

  it("retries once on invalid output, then succeeds", async () => {
    create.mockResolvedValueOnce({ output_text: "not json" }).mockResolvedValueOnce({
      output_text: '{"label":"give_hint","confidence":0.8,"reason":"stuck"}',
    });
    const { generateStructured } = await import("./gemini");

    await expect(generateStructured(request)).resolves.toMatchObject({ label: "give_hint" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retry with a StructuredOutputError", async () => {
    create.mockResolvedValue({ output_text: '{"label":"shout","confidence":7}' });
    const { generateStructured, StructuredOutputError } = await import("./gemini");

    await expect(generateStructured(request)).rejects.toBeInstanceOf(StructuredOutputError);
    expect(create).toHaveBeenCalledTimes(2);
  });
});

describe("toGeminiSchema", () => {
  it("keeps supported keywords and drops the rest", async () => {
    const { toGeminiSchema } = await import("./gemini");
    const schema = toGeminiSchema(MewOutput);

    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({
      type: "object",
      required: ["label", "confidence", "reason"],
      properties: {
        label: {
          type: "string",
          enum: expect.arrayContaining(["ignore", "draw_visual"]) as unknown,
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reason: { type: "string" },
      },
    });
    expect(JSON.stringify(schema)).not.toContain("maxLength");
  });
});

describe("toGeminiSchema for the tutor's response", () => {
  it("keeps every board action (unions become anyOf) and sends no array bounds", async () => {
    const { TutorResponse } = await import("@mew/shared");
    const { toGeminiSchema } = await import("./gemini");
    const schema = toGeminiSchema(TutorResponse);
    const text = JSON.stringify(schema);

    // Regression: zod emits discriminated unions as oneOf, which used to be dropped, leaving the
    // model no description of an action at all.
    const items = (schema as { properties: { actions: { items: { anyOf: unknown[] } } } })
      .properties.actions.items;
    expect(items.anyOf).toHaveLength(10);
    for (const tag of [
      "write_math",
      "mark_error",
      "draw_plot",
      "draw_graph",
      "draw_shapes",
      "draw_geometry",
      "draw_molecule",
    ]) {
      expect(text).toContain(`"enum":["${tag}"]`);
    }
    // Gemini rejects array bounds combined with unions or nesting (400, checked against the API).
    expect(text).not.toMatch(/"(minItems|maxItems)"/);
    expect(text).not.toContain("oneOf");
  });
});

describe("toGeminiSchema's union variants", () => {
  it("put each variant's tag first (Gemini writes properties in schema order)", async () => {
    const { CircleAskModelResponse, ScreenTutorResponse, TutorResponse } =
      await import("@mew/shared");
    const { toGeminiSchema } = await import("./gemini");
    // Regression (K5): draw_molecule listed "smiles" before "type", so once the model had written
    // "type" it could never pick a molecule (it drew a hexagon for benzene instead).
    const firsts: string[] = [];
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (typeof node !== "object" || node === null) return;
      const record = node as Record<string, unknown>;
      if (Array.isArray(record.anyOf)) {
        for (const variant of record.anyOf as { properties?: Record<string, unknown> }[]) {
          const keys = Object.keys(variant.properties ?? {});
          if (keys.some((k) => k === "type" || k === "kind")) firsts.push(keys[0] ?? "");
        }
      }
      Object.values(record).forEach(visit);
    };
    for (const schema of [TutorResponse, CircleAskModelResponse, ScreenTutorResponse]) {
      visit(toGeminiSchema(schema));
    }
    expect(firsts.length).toBeGreaterThan(20);
    expect(firsts.every((key) => key === "type" || key === "kind")).toBe(true);
  });
});

describe("cooldown after quota or overload errors", () => {
  beforeEach(() => {
    vi.resetModules();
    create.mockReset();
    vi.stubEnv("GEMINI_API_KEY", "test-key");
  });

  it("reads how long to wait from the error, capped, and ignores other errors", async () => {
    const { cooldownFor } = await import("./gemini");
    const quota = (text: string) => new Error(`429 Rate limit exceeded. ${text}`);
    expect(cooldownFor(quota("Please retry in 51s"))).toBe(51_000);
    expect(cooldownFor(quota("Please retry in 2m5s"))).toBe(125_000);
    // A daily quota ("18 hours") is re-checked every 15 minutes instead.
    expect(cooldownFor(quota("Please retry in 18h39m51s"))).toBe(15 * 60_000);
    expect(cooldownFor(quota("upgrade your tier"))).toBe(60_000);
    expect(cooldownFor(new Error("503 model is currently experiencing high demand"))).toBe(20_000);
    expect(cooldownFor(new Error("Request timed out"))).toBeNull();
    expect(cooldownFor(new Error("400 invalid argument"))).toBeNull();
  });

  it("fails fast, without a request, while a model cools down; other models still work", async () => {
    const { generateStructured, ModelBusyError } = await import("./gemini");
    create.mockRejectedValueOnce(new Error("429 Rate limit exceeded. Please retry in 30s"));

    await expect(generateStructured(request)).rejects.toThrow(/429/);
    await expect(generateStructured(request)).rejects.toBeInstanceOf(ModelBusyError);
    expect(create).toHaveBeenCalledTimes(1);

    create.mockResolvedValue({
      output_text: '{"label":"ignore","confidence":0.9,"reason":"filler"}',
    });
    await expect(generateStructured({ ...request, model: "other-model" })).resolves.toMatchObject({
      label: "ignore",
    });
  });
});
