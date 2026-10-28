import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HandwritingCapture } from "@/features/handwriting/HandwritingCapture";
import { devPagesEnabled } from "@/lib/dev-pages";

export const metadata: Metadata = { title: "Handwriting samples · Neb" };

/** The team's capture page for real handwriting eval samples (K10 §8.1). Never in production. */
export default function HandwritingCapturePage() {
  if (!devPagesEnabled) notFound();
  return <HandwritingCapture />;
}
