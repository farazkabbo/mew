import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FinishDesktopSignIn } from "@/features/desktop/FinishDesktopSignIn";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Signing in · Neb" };

/** Where the desktop window goes when the browser has finished signing in. */
export default function FinishDesktopSignInPage() {
  if (!isClerkConfigured) notFound();
  return <FinishDesktopSignIn />;
}
