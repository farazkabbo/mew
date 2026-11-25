import type { Metadata } from "next";

import { HandoffViewer } from "@/features/handoff/HandoffViewer";

export const metadata: Metadata = { title: "Handoff · Neb", robots: { index: false } };

/** A handoff's link: the viewer (signed in, a member) or only whose it is (signed out). */
export default async function HandoffPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <HandoffViewer id={id} />;
}
