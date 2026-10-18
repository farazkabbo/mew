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
    expect(items.anyOf).toHaveLength(8);
    for (const tag of ["write_math", "mark_error", "draw_plot", "draw_graph", "draw_shapes"]) {
      expect(text).toContain(`"enum":["${tag}"]`);
    }
    // Gemini rejects array bounds combined with unions or nesting (400, checked against the API).
    expect(text).not.toMatch(/"(minItems|maxItems)"/);
    expect(text).not.toContain("oneOf");
  });
});
