import "server-only";

import { z } from "zod";

type EnvOptions<T extends z.ZodObject> = {
  /** Applied in every environment (e.g. model ids, which are configuration, not secrets). */
  defaults?: Partial<z.input<T>>;
  /** Applied outside production only (e.g. localhost URLs). */
  devDefaults?: Partial<z.input<T>>;
};

/**
 * Server-only environment, validated lazily per concern so a missing variable for one feature
 * (e.g. the Gemini key) can't take down unrelated routes. Error messages name variables, never
 * values.
 */
function defineEnv<T extends z.ZodObject>(
  schema: T,
  { defaults, devDefaults }: EnvOptions<T> = {},
) {
  let cached: z.output<T> | undefined;
  return (): z.output<T> => {
    if (cached) return cached;
    const dev = process.env.NODE_ENV === "production" ? {} : devDefaults;
    const parsed = schema.safeParse({ ...defaults, ...dev, ...pickDefined(process.env) });
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new EnvError(`Invalid server environment — ${problems.join("; ")}`);
    }
    cached = parsed.data;
    return cached;
  };
}

export class EnvError extends Error {
  override readonly name = "EnvError";
}

function pickDefined(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export const appEnv = defineEnv(z.object({ APP_ORIGIN: z.url() }), {
  devDefaults: { APP_ORIGIN: "http://localhost:3000" },
});

export const apiEnv = defineEnv(
  z.object({
    API_BASE_URL: z.url(),
    INTERNAL_API_SECRET: z.string().min(32, "must be at least 32 characters"),
  }),
  { devDefaults: { API_BASE_URL: "http://127.0.0.1:8000" } },
);

export const geminiEnv = defineEnv(
  z.object({
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_GATE_MODEL: z.string().min(1),
    GEMINI_TUTOR_MODEL: z.string().min(1),
  }),
  {
    defaults: {
      GEMINI_GATE_MODEL: "gemini-3.5-flash-lite",
      GEMINI_TUTOR_MODEL: "gemini-3.8-flash",
    },
  },
);

export const elevenLabsEnv = defineEnv(
  z.object({
    ELEVENLABS_API_KEY: z.string().min(1),
    ELEVENLABS_STT_MODEL: z.string().min(1),
  }),
  { defaults: { ELEVENLABS_STT_MODEL: "scribe_v2_realtime" } },
);

export const ttsEnv = defineEnv(
  z.object({
    ELEVENLABS_API_KEY: z.string().min(1),
    // Part of the upstream URL path, so restricted to the ID alphabet.
    ELEVENLABS_VOICE_ID: z.string().regex(/^[A-Za-z0-9]{8,64}$/, "must be an ElevenLabs voice ID"),
    ELEVENLABS_TTS_MODEL: z.string().min(1),
  }),
  { defaults: { ELEVENLABS_TTS_MODEL: "eleven_flash_v2_5" } },
);
