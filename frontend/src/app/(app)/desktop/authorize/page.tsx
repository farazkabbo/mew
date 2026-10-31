import { auth } from "@clerk/nextjs/server";
import { DeviceChallenge } from "@mew/shared";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AuthorizeDesktop } from "@/features/desktop/AuthorizeDesktop";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Sign in to Neb Desktop · Neb" };

/**
 * Opened in the browser by the desktop app's Continue with browser. Signed-out visitors go through
 * the website's normal sign-in or sign-up and come back here, so there's one account for both.
 */
export default async function AuthorizeDesktopPage({
  searchParams,
}: {
  searchParams: Promise<{ challenge?: string | string[] }>;
}) {
  if (!isClerkConfigured) notFound();
  await auth.protect();
  const challenge = DeviceChallenge.safeParse((await searchParams).challenge);
  return <AuthorizeDesktop challenge={challenge.success ? challenge.data : null} />;
}
