import type { Metadata } from "next";

import { HandoffInbox } from "@/features/handoff/HandoffInbox";

export const metadata: Metadata = { title: "Handoffs · Neb" };

export default function HandoffsPage() {
  return <HandoffInbox />;
}
