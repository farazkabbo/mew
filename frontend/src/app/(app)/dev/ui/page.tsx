import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { devPagesEnabled } from "@/lib/dev-pages";

import { UiPreview } from "./UiPreview";

export const metadata: Metadata = { title: "UI · Neb" };

/**
 * Every component of the U series in every state (docs/NEB_APP_UI.md §7), for review and the
 * light/night screenshot tests. Development only.
 */
export default function UiPreviewPage() {
  if (!devPagesEnabled) notFound();
  return <UiPreview />;
}
