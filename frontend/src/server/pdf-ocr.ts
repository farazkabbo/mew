import "server-only";

import { PDF_PAGE_OCR_PROMPT, PdfPageOcr } from "@mew/shared";

import { geminiEnv } from "./env";
import { type GenerateStructured, generateStructured } from "./gemini";

/** "Recognize text" (K4 §5.2): the text of a scanned PDF page, read from its picture (PNG). */
export async function recognizePdfPage(
  png: ArrayBuffer,
  generate: GenerateStructured = generateStructured,
): Promise<PdfPageOcr> {
  const read = await generate({
    model: geminiEnv().GEMINI_GATE_MODEL,
    system: PDF_PAGE_OCR_PROMPT.system,
    input: [
      { type: "text", text: "Transcribe this page." },
      { type: "image", base64: Buffer.from(png).toString("base64"), mimeType: "image/png" },
    ],
    schema: PdfPageOcr,
    thinkingLevel: "minimal",
    maxOutputTokens: 6000,
    timeoutMs: 30_000,
  });
  return { text: read.text.trim() };
}
