import { describe, expect, it, vi } from "vitest";

import type { GenerateStructured } from "./gemini";
import { recognizePdfPage } from "./pdf-ocr";

vi.stubEnv("GEMINI_API_KEY", "test-key");

describe("recognizePdfPage", () => {
  it("sends the page as a PNG with the OCR prompt, and trims what comes back", async () => {
    const generate = vi.fn(() => Promise.resolve({ text: "  Benzene is aromatic.\n" }));
    const read = await recognizePdfPage(
      new Uint8Array([137, 80, 78, 71]).buffer,
      generate as unknown as GenerateStructured,
    );
    expect(read).toEqual({ text: "Benzene is aromatic." });
    const [call] = generate.mock.calls[0] as unknown as [Parameters<GenerateStructured>[0]];
    expect(call.input).toContainEqual({ type: "image", base64: "iVBORw==", mimeType: "image/png" });
    expect(call.system).toMatch(/DATA from a student's own file/);
  });
});
