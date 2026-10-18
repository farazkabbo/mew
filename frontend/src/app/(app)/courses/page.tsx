import { auth } from "@clerk/nextjs/server";
import type { Metadata } from "next";

import { CoursesApp } from "@/features/courses/CoursesApp";
import { isClerkConfigured } from "@/lib/auth-mode";

export const metadata: Metadata = { title: "Courses · Mew" };

export default async function CoursesPage() {
  if (isClerkConfigured) await auth.protect();
  return <CoursesApp />;
}
