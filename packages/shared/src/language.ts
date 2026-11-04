import { z } from "zod";

/** The languages neb can listen and speak in. Mirrors NebLanguage in backend profiles/models.py. */
export const NebLanguage = z.enum(["en", "fr", "bn", "zh"]);
export type NebLanguage = z.infer<typeof NebLanguage>;

type LanguageProfile = {
  /** Its name, as the student reads it in the picker. */
  label: string;
  /** Its name in the instruction to the model. */
  name: string;
  /** Scribe's language code (always set: detecting it misheard short English phrases). */
  scribeCode: string | null;
  /** The speech model when the configured one can't speak it (Flash has no Bengali). */
  ttsModel: string | null;
  /** What the voice sample in Settings says. */
  sample: string;
};

export const NEB_LANGUAGES: Record<NebLanguage, LanguageProfile> = {
  en: {
    label: "English",
    name: "English",
    scribeCode: "eng",
    ttsModel: null,
    sample: "Hi, I'm Neb. I'll stay quiet until you need me.",
  },
  fr: {
    label: "Français",
    name: "French",
    scribeCode: "fra",
    ttsModel: null,
    sample: "Bonjour, je suis Neb. Je reste discret jusqu'à ce que vous ayez besoin de moi.",
  },
  bn: {
    label: "বাংলা",
    name: "Bengali",
    scribeCode: "ben",
    ttsModel: "eleven_v4_turbo",
    sample: "নমস্কার, আমি নেব। আপনার যখন দরকার হবে, আমি তখনই কথা বলব।",
  },
  zh: {
    label: "中文",
    name: "Mandarin Chinese (Simplified)",
    scribeCode: "zho",
    ttsModel: null,
    sample: "你好，我是 Neb。在你需要我之前，我会保持安静。",
  },
};

/**
 * A prompt told which language to answer in. English leaves it exactly as it is. Drawn text stays
 * in English because the handwriting font (Hershey) only has basic Latin letters: anything else
 * would be dropped from the ink. That also keeps labels readable by the English safety rules.
 */
export function inLanguage(system: string, language: NebLanguage = "en"): string {
  if (language === "en") return system;
  const { name } = NEB_LANGUAGES[language];
  return `${system}

LANGUAGE:
- Say everything the student will hear in ${name}, whatever language they or the screen use: every field read aloud, such as "speech", "say", instructions, hints and questions.
- Everything drawn or written as ink (labels, notes, written steps) stays in plain English letters and maths, without accents: the handwriting can't draw anything else.
- Name buttons and menus exactly as they appear on the screen.`;
}
