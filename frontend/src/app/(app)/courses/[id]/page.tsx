import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CourseRedirect } from "@/features/courses/CourseRedirect";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Course · Neb" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A course is its notebook's Study tab now (decision U26); old links still land there. */
export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  if (isClerkConfigured) await auth.protect();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <CourseRedirect id={id} />;
}
