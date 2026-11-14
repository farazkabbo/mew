import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { StartTour } from "@/features/tour/StartTour";
import { isClerkConfigured, LOCAL_USER_ID } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Take the tour · Neb" };

/** Starts the guided tour over the real app (docs/NEB_APP_UI.md decision U32). */
export default async function TourPage() {
  const userId = isClerkConfigured ? (await auth.protect()).userId : LOCAL_USER_ID;
  return <StartTour userId={userId} />;
}
