import "server-only";

import { ApiWhoAmI } from "@mew/shared";

import { createServerSupabase } from "@/lib/supabase/server";

import { ApiError, apiFetch } from "./api-client";

export type Check = { name: string; ok: boolean; detail: string };

/** Web → FastAPI with the user's Clerk token: proves the internal secret and JWT verification line up. */
export async function checkApiAuth(userId: string, token: string | null): Promise<Check> {
  const name = "API verifies your session";
  try {
    const me = await apiFetch("/v1/me", ApiWhoAmI, { token });
    return me.user_id === userId
      ? { name, ok: true, detail: "FastAPI verified the Clerk token for this user." }
      : { name, ok: false, detail: "FastAPI returned a different user id." };
  } catch (error) {
    return { name, ok: false, detail: describeApiError(error) };
  }
}

/** Web → Supabase as the user: proves third-party auth (Clerk) and RLS are configured. */
export async function checkSupabaseRls(userId: string): Promise<Check> {
  const name = "Supabase accepts your session (RLS)";
  try {
    const supabase = await createServerSupabase();
    const upsert = await supabase
      .from("profiles")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
    if (upsert.error) return { name, ok: false, detail: describeSupabaseError(upsert.error.code) };

    const select = await supabase.from("profiles").select("id").eq("id", userId).maybeSingle();
    if (select.error) return { name, ok: false, detail: describeSupabaseError(select.error.code) };
    return select.data
      ? { name, ok: true, detail: "Read your own profile row through RLS." }
      : {
          name,
          ok: false,
          detail: "Profile row is not visible — check the profiles RLS policies.",
        };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : "Unknown error" };
  }
}

function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Unknown error";
  switch (error.status) {
    case null:
      return `API unreachable (${error.message}). Is services/api running?`;
    case 401:
      return "API rejected the request — check INTERNAL_API_SECRET matches and CLERK_ISSUER / CLERK_AUTHORIZED_PARTIES are set for services/api.";
    case 503:
      return "API auth is not configured — set CLERK_ISSUER for services/api.";
    default:
      return error.message;
  }
}

function describeSupabaseError(code: string | undefined): string {
  switch (code) {
    case "PGRST205":
    case "42P01":
      return "The profiles table is missing — apply the migrations in supabase/migrations.";
    case "PGRST301":
    case "PGRST302":
      return "Supabase rejected the token — add Clerk under Authentication → Third-party auth.";
    case "42501":
      return "Permission denied — the Clerk token needs the role=authenticated claim (Clerk: Connect with Supabase).";
    default:
      return `Supabase error ${code ?? "(no code)"}.`;
  }
}
