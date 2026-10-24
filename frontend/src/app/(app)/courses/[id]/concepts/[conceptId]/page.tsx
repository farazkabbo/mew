import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { LessonView } from "@/features/courses/LessonView";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Lesson · Neb" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function LessonPage({
  params,
}: {
  params: Promise<{ id: string; conceptId: string }>;
}) {
  if (isClerkConfigured) await auth.protect();
  const { id, conceptId } = await params;
  if (!UUID.test(id) || !UUID.test(conceptId)) notFound();
  return <LessonView courseId={id} conceptId={conceptId} />;
}
