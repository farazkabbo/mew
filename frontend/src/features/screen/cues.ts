import type { NebLanguage } from "@mew/shared";

/**
 * The cursor modes' short words (docs/CURSOR_MODES.md, H): SHOW ME's corrections ("below",
 * "left", "not that one") and a few lines that end a lesson. They're spoken from clips made once
 * per language and voice, kept in memory and in the browser's cache, so a correction is never
 * waiting on the network at the moment it matters. Without a clip (offline, first run), the
 * browser's own voice says it.
 */
export const CUE_KEYS = [
  "below",
  "above",
  "left",
  "right",
  "not_that_one",
  "done",
  "go_ahead",
] as const;
export type CueKey = (typeof CUE_KEYS)[number];

export const CUE_WORDS: Record<NebLanguage, Record<CueKey, string>> = {
  en: {
    below: "Below.",
    above: "Above.",
    left: "Left.",
    right: "Right.",
    not_that_one: "Not that one.",
    done: "That's it.",
    go_ahead: "You've got this one.",
  },
  fr: {
    below: "En dessous.",
    above: "Au-dessus.",
    left: "À gauche.",
    right: "À droite.",
    not_that_one: "Pas celui-là.",
    done: "C'est fait.",
    go_ahead: "Celui-là, tu le connais.",
  },
  bn: {
    below: "নিচে।",
    above: "উপরে।",
    left: "বাঁয়ে।",
    right: "ডানে।",
    not_that_one: "ওটা না।",
    done: "হয়ে গেছে।",
    go_ahead: "এটা তুমি পারো।",
  },
  zh: {
    below: "下面。",
    above: "上面。",
    left: "左边。",
    right: "右边。",
    not_that_one: "不是那个。",
    done: "好了。",
    go_ahead: "这个你会了。",
  },
};

export function isCueKey(value: unknown): value is CueKey {
  return typeof value === "string" && (CUE_KEYS as readonly string[]).includes(value);
}

export type CueDeps = {
  /** The student's language and voice now. */
  voice: () => { language: NebLanguage; voiceId: string | null };
  /** Makes a clip (PCM) for a line, or null. */
  synthesize: (
    text: string,
    language: NebLanguage,
    voiceId: string | null,
  ) => Promise<Uint8Array | null>;
  /** A clip kept from an earlier session, or null. */
  load: (key: string) => Promise<Uint8Array | null>;
  store: (key: string, pcm: Uint8Array) => Promise<void>;
  play: (pcm: Uint8Array) => Promise<void>;
  /** The browser's own voice, for when there's no clip. */
  fallback: (text: string, language: NebLanguage) => void;
};

/** Plays cue words from clips made ahead of time. */
export class CueVoice {
  private readonly clips = new Map<string, Uint8Array>();
  private preparing: Promise<void> | null = null;
  private preparedFor = "";

  constructor(private readonly deps: CueDeps) {}

  private static key(language: NebLanguage, voiceId: string | null, cue: CueKey): string {
    return `${language}|${voiceId ?? "default"}|${cue}`;
  }

  /** Makes (or loads) every clip for the current language and voice, once. */
  prepare(): Promise<void> {
    const { language, voiceId } = this.deps.voice();
    const tag = `${language}|${voiceId ?? "default"}`;
    if (this.preparing && this.preparedFor === tag) return this.preparing;
    this.preparedFor = tag;
    this.preparing = (async () => {
      for (const cue of CUE_KEYS) {
        const key = CueVoice.key(language, voiceId, cue);
        if (this.clips.has(key)) continue;
        const kept = await this.deps.load(key).catch(() => null);
        const pcm =
          kept ??
          (await this.deps
            .synthesize(CUE_WORDS[language][cue], language, voiceId)
            .catch(() => null));
        if (!pcm) continue;
        this.clips.set(key, pcm);
        if (!kept) await this.deps.store(key, pcm).catch(() => undefined);
      }
    })();
    return this.preparing;
  }

  /** Says `cue` now: from its clip if there is one, otherwise with the browser's voice. */
  async say(cue: CueKey): Promise<void> {
    const { language, voiceId } = this.deps.voice();
    const pcm = this.clips.get(CueVoice.key(language, voiceId, cue));
    if (pcm) {
      await this.deps.play(pcm);
      return;
    }
    this.deps.fallback(CUE_WORDS[language][cue], language);
    void this.prepare();
  }
}
