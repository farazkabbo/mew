import { auth, currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { ReviewApp } from "@/features/courses/ReviewApp";
import { isClerkConfigured, LOCAL_USER_ID } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Review · Neb" };

export default async function ReviewPage() {
  // The folders take their colours from this user's notebooks (one IndexedDB database each).
  const userId = isClerkConfigured ? (await auth.protect()).userId : LOCAL_USER_ID;
  const name = isClerkConfigured ? ((await currentUser())?.firstName ?? null) : null;
  return <ReviewApp userId={userId} name={name} />;
}
