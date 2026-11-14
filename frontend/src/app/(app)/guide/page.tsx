import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { Guide } from "@/features/guide/Guide";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "How to use neb · Neb" };

/** The guide (docs/NEB_APP_UI.md decision U30): how to do each thing, in numbered steps. */
export default async function GuidePage() {
  if (isClerkConfigured) await auth.protect();
  return <Guide />;
}
