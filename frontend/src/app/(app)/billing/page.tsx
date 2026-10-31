import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { BillingApp } from "@/features/billing/BillingApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Billing · Neb" };

export default async function BillingPage() {
  if (isClerkConfigured) await auth.protect();
  return <BillingApp />;
}

