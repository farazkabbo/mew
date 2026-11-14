import { auth } from "@clerk/nextjs/server";
import { DeviceChallenge } from "@mew/shared";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { AuthorizeDesktop } from "@/features/desktop/AuthorizeDesktop";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Connect neb on this computer · Neb" };

/** The app's random value, echoed back in the neb:// link so the app knows it's its own. */
const State = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/);
/** What the app says it is (a kind of computer, never its name). */
const Device = z.enum(["windows"]);

type Search = {
  challenge?: string | string[];
  state?: string | string[];
  device?: string | string[];
  at?: string | string[];
};

/**
 * Opened in the browser by the desktop app's Sign in. Someone without an account signs up here
 * first (the form has "Already have an account? Sign in"), then comes back to this page; someone
 * signed in goes straight to the question, so there's one account for both.
 */
export default async function AuthorizeDesktopPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  if (!isClerkConfigured) notFound();
  const params = await searchParams;
  const { userId } = await auth();
  if (!userId) {
    const back = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") back.set(key, value);
    }
    redirect(
      `/sign-up?redirect_url=${encodeURIComponent(`/desktop/authorize?${back.toString()}`)}`,
    );
  }
  const challenge = DeviceChallenge.safeParse(params.challenge);
  const state = State.safeParse(params.state);
  const device = Device.safeParse(params.device);
  const at = Number(typeof params.at === "string" ? params.at : NaN);
  return (
    <AuthorizeDesktop
      challenge={challenge.success ? challenge.data : null}
      state={state.success ? state.data : null}
      device={device.success ? device.data : null}
      startedAt={Number.isInteger(at) ? at : null}
    />
  );
}
