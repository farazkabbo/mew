import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { ReviewApp } from "@/features/courses/ReviewApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Review · Mew" };

export default async function ReviewPage() {
  if (isClerkConfigured) await auth.protect();
  return <ReviewApp />;
}
