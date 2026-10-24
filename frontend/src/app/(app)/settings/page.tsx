import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { SettingsApp } from "@/features/settings/SettingsApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Settings · Neb" };

export default async function SettingsPage() {
  if (isClerkConfigured) await auth.protect();
  return <SettingsApp />;
}
