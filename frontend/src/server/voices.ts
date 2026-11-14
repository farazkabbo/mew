import "server-only";

import type { NebLanguage, Voice } from "@mew/shared";

import { ttsEnv } from "./env";

/**
 * The voices a student may pick in Settings: the configured default, plus any listed in
 * ELEVENLABS_VOICES. Only these IDs ever reach ElevenLabs (an ID is part of the upstream URL).
 */
export function availableVoices(): Voice[] {
  const { ELEVENLABS_VOICE_ID, ELEVENLABS_VOICES } = ttsEnv();
  const listed = (ELEVENLABS_VOICES ?? "")
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [name = "", id = ""] = entry.split(":");
      return { id: id.trim(), name: name.trim() };
    });
  const voices = listed.some((v) => v.id === ELEVENLABS_VOICE_ID)
    ? listed
    : [{ id: ELEVENLABS_VOICE_ID, name: "Default" }, ...listed];
  return voices.filter((v, i) => voices.findIndex((w) => w.id === v.id) === i);
}

/**
 * The voice to speak with: the one configured for this language if there is one, then the requested
 * voice if it's allowed, else the default. (Our voices all speak every language, with an accent.)
 */
export function resolveVoice(
  requested: string | null | undefined,
  language: NebLanguage = "en",
): string {
  const env = ttsEnv();
  const forLanguage = {
    en: undefined,
    fr: env.ELEVENLABS_VOICE_FR,
    bn: env.ELEVENLABS_VOICE_BN,
    zh: env.ELEVENLABS_VOICE_ZH,
  }[language];
  if (forLanguage) return forLanguage;
  const voices = availableVoices();
  return voices.find((v) => v.id === requested)?.id ?? ttsEnv().ELEVENLABS_VOICE_ID;
}
