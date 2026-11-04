import { redirect } from "next/navigation";

/** Courses live in their notebooks now (docs/NEB_APP_UI.md decision U26): the desk lists them. */
export default function CoursesPage() {
  redirect("/desk");
}
