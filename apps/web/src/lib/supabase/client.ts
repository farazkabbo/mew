"use client";

import { useSession } from "@clerk/nextjs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useMemo } from "react";

import { publicEnv } from "@/lib/public-env";

/** Browser Supabase client bound to the current Clerk session; all access is enforced by RLS. */
export function useSupabase(): SupabaseClient {
  const { session } = useSession();
  return useMemo(() => {
    const env = publicEnv();
    return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
      accessToken: async () => (await session?.getToken()) ?? null,
    });
  }, [session]);
}
