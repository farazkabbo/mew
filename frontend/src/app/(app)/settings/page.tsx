import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { sectionOf } from "@/features/settings/sections";
import { SettingsApp } from "@/features/settings/SettingsApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Settings · Neb" };

/**
 * `?section=` picks the page; `?embed=1` is the desktop app's settings window showing one page
 * on its own (no header or sidebar: the window has its own).
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string | string[]; embed?: string | string[] }>;
}) {
  if (isClerkConfigured) await auth.protect();
  const { section, embed } = await searchParams;
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  return <SettingsApp section={sectionOf(one(section))} embed={one(embed) === "1"} />;
}
