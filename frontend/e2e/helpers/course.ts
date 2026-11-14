import { expect, type Page } from "../fixtures";

/**
 * Builds a course from a PDF the way the notebook's "Add course material" does (the same
 * `/api/courses` call, made from the app's own page so its origin checks pass), then opens it:
 * a course link lands on its notebook's Study tab (docs/NEB_APP_UI.md decision U26).
 */
export async function createCourse(page: Page, pdf: Buffer, title: string): Promise<string> {
  await page.goto("/desk");
  const id = await page.evaluate(
    async ({ bytes, title }) => {
      const form = new FormData();
      form.set(
        "file",
        new File([new Uint8Array(bytes)], "chapter-3.pdf", { type: "application/pdf" }),
      );
      form.set("title", title);
      const response = await fetch("/api/courses", { method: "POST", body: form });
      if (!response.ok) throw new Error(`Couldn't create the course (${response.status})`);
      return ((await response.json()) as { id: string }).id;
    },
    { bytes: [...pdf], title },
  );
  await page.goto(`/courses/${id}`);
  // The address becomes the notebook's home once it's open (U29).
  await expect(page).toHaveURL(/\/notebook\?/);
  await expect(page.getByRole("tab", { name: "Study" })).toHaveAttribute("aria-selected", "true");
  return id;
}
