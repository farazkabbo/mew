import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { TeachApp } from "@/features/teach/TeachApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Teach Neb · Neb" };

export default async function TeachPage() {
  if (isClerkConfigured) await auth.protect();
  return <TeachApp />;
}
