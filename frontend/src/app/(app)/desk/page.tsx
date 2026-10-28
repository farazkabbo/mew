import { auth, currentUser } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { NotebookApp } from "@/features/notebook/NotebookApp";
import { isClerkConfigured, LOCAL_USER_ID } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Desk · Neb" };

/** The desk (docs/NEB_APP_UI.md §5.1): the app's home, inside the notebook app. */
export default async function DeskPage() {
  // Local notebook data is partitioned per signed-in user (one IndexedDB database each).
  const userId = isClerkConfigured ? (await auth.protect()).userId : LOCAL_USER_ID;
  const name = isClerkConfigured ? ((await currentUser())?.firstName ?? null) : null;
  return <NotebookApp userId={userId} start="desk" name={name} />;
}
