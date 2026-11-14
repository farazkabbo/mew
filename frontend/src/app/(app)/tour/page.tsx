import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { Tour } from "@/features/tour/Tour";
import { isClerkConfigured, LOCAL_USER_ID } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Take the tour · Neb" };

/** The interactive tour (docs/NEB_APP_UI.md decision U31). */
export default async function TourPage() {
  const userId = isClerkConfigured ? (await auth.protect()).userId : LOCAL_USER_ID;
  return <Tour userId={userId} />;
}
