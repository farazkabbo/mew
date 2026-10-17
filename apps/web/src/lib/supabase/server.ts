import "server-only";

import { auth } from "@clerk/nextjs/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { publicEnv } from "@/lib/public-env";

/**
 * Supabase client that acts as the signed-in Clerk user, so every query is subject to RLS.
 * Supabase verifies the Clerk session token via its third-party auth integration.
 */
export async function createServerSupabase(): Promise<SupabaseClient> {
  const { getToken } = await auth();
  const env = publicEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    accessToken: async () => (await getToken()) ?? null,
  });
}
