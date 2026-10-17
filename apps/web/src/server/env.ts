import "server-only";

import { z } from "zod";

/**
 * Server-only environment, validated lazily per concern so a missing variable for one feature
 * (e.g. the API secret) can't take down unrelated routes. Error messages name variables, never values.
 */
function defineEnv<T extends z.ZodObject>(schema: T, devDefaults: Partial<z.input<T>> = {}) {
  let cached: z.output<T> | undefined;
  return (): z.output<T> => {
    if (cached) return cached;
    const defaults = process.env.NODE_ENV === "production" ? {} : devDefaults;
    const parsed = schema.safeParse({ ...defaults, ...pickDefined(process.env) });
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`Invalid server environment — ${problems.join("; ")}`);
    }
    cached = parsed.data;
    return cached;
  };
}

function pickDefined(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );
}

export const appEnv = defineEnv(z.object({ APP_ORIGIN: z.url() }), {
  APP_ORIGIN: "http://localhost:3000",
});

export const apiEnv = defineEnv(
  z.object({
    API_BASE_URL: z.url(),
    INTERNAL_API_SECRET: z.string().min(32, "must be at least 32 characters"),
  }),
  { API_BASE_URL: "http://127.0.0.1:8000" },
);
