import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { CourseApp } from "@/features/courses/CourseApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Course · Neb" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  if (isClerkConfigured) await auth.protect();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <CourseApp id={id} />;
}
