import { describe, expect, it } from "vitest";

import { inLanguage, NEB_LANGUAGES, NebLanguage } from "./language";
import { DEFAULT_SETTINGS, UserSettings } from "./settings";

describe("neb's language", () => {
  it("leaves the English prompts exactly as they are", () => {
    expect(inLanguage("The prompt.")).toBe("The prompt.");
    expect(inLanguage("The prompt.", "en")).toBe("The prompt.");
  });

  it("asks for speech in the language and ink in English", () => {
    const prompt = inLanguage("The prompt.", "bn");
    expect(prompt.startsWith("The prompt.")).toBe(true);
    expect(prompt).toContain("hear in Bengali");
    expect(prompt).toContain("plain English letters");
  });

  it("starts in English, and refuses a language it doesn't have", () => {
    expect(DEFAULT_SETTINGS.language).toBe("en");
    expect(UserSettings.safeParse({ ...DEFAULT_SETTINGS, language: "de" }).success).toBe(false);
  });

  it("only Bengali needs another speech model, and English keeps automatic detection", () => {
    expect(NebLanguage.options.filter((l) => NEB_LANGUAGES[l].ttsModel)).toEqual(["bn"]);
    expect(NEB_LANGUAGES.en.scribeCode).toBeNull();
  });
});
