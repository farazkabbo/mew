import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { LinkDevice } from "@/features/desktop/LinkDevice";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Connect Screen Coach · Neb" };

/** Opened by the desktop app to connect it to the signed-in account (Screen Coach). */
export default async function LinkDevicePage() {
  if (isClerkConfigured) await auth.protect();
  return <LinkDevice />;
}
