import { z } from "zod";

const PublicEnv = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({ protocol: /^https?$/ }),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(1)
    .refine(
      (key) => !key.startsWith("sb_secret_"),
      "must be the publishable key, never a secret key",
    ),
});
export type PublicEnv = z.infer<typeof PublicEnv>;

let cached: PublicEnv | undefined;

/** Browser-safe config. Each variable is referenced literally so Next.js can inline it at build time. */
export function publicEnv(): PublicEnv {
  cached ??= PublicEnv.parse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  });
  return cached;
}
