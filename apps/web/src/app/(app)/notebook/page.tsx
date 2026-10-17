import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { NotebookApp } from "@/features/notebook/NotebookApp";
import { isClerkConfigured, LOCAL_USER_ID } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Notebook · Mew" };

export default async function NotebookPage() {
  // Local notebook data is partitioned per signed-in user (one IndexedDB database each).
  const userId = isClerkConfigured ? (await auth.protect()).userId : LOCAL_USER_ID;
  return <NotebookApp userId={userId} />;
}
