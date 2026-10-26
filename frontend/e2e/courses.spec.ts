import { expect, type Page, test } from "./fixtures";

import { CHAPTER, makePdf } from "./helpers/pdf";

/**
 * M7 acceptance: upload a chapter PDF → see ordered concepts with prerequisites → the tutor's
 * answers can cite the right pages. Runs against the real API service (PDF parsing, chunking,
 * retrieval, local course store) without model keys, so concepts come from the headings and
 * retrieval is lexical. The tutor model itself is mocked: we check what it is given.
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

async function uploadChapter(page: Page) {
  await page.goto("/courses");
  await page.locator('input[type="file"]').setInputFiles({
    name: "chapter-3.pdf",
    mimeType: "application/pdf",
    buffer: makePdf(CHAPTER),
  });
  await expect(page.getByLabel("Course title")).toHaveValue("chapter-3");
  await page.getByLabel("Course title").fill("Forces and motion");
  await page.getByRole("button", { name: "Build course" }).click();
  await expect(page).toHaveURL(/\/courses\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Needs review")).toBeVisible({ timeout: 30_000 });
}

test("a chapter PDF becomes an ordered plan, reviewed by the student", async ({ page }) => {
  test.setTimeout(90_000);
  await uploadChapter(page);

  // The proposed concepts, in order, each with its pages and what it builds on.
  const rows = page.getByTestId("review-concept");
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0).getByRole("textbox")).toHaveValue("Forces");
  await expect(rows.nth(1).getByRole("textbox")).toHaveValue("Newtons Laws");
  await expect(rows.nth(2).getByRole("textbox")).toHaveValue("Friction");
  await expect(rows.nth(1)).toContainText("Needs: Forces");
  await expect(rows.nth(2)).toContainText("p. 3");

  // Merge Newton's laws into Forces, rename it, set an exam date, and start.
  await rows.nth(1).getByRole("button", { name: "Merge into the one above" }).click();
  await expect(rows.nth(1)).toContainText("Merged into “Forces”");
  await rows.nth(0).getByRole("textbox").fill("Forces and Newton's laws");
  await page.getByLabel("Exam date (optional)").fill("2026-12-04");
  await page.getByRole("button", { name: "Start studying (2 concepts)" }).click();

  const plan = page.getByTestId("plan-concept");
  await expect(plan).toHaveCount(2);
  await expect(plan.nth(0)).toContainText("Forces and Newton's laws");
  await expect(plan.nth(0)).toContainText("pp. 1–2");
  // The merged concept's prerequisite edge followed it.
  await expect(plan.nth(1)).toContainText("Needs: Forces and Newton's laws");
  await expect(page.getByText(/exam in \d+ days/)).toBeVisible();

  // A lesson, grounded in its pages (no model key: the summary and the source passage).
  await plan.nth(1).getByRole("link", { name: "Friction" }).click();
  await expect(page.getByRole("heading", { name: "Friction", level: 1 })).toBeVisible();
  await expect(page.getByText("From p. 3", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/opposes sliding/).first()).toBeVisible();

  // The course is listed.
  await page.goto("/courses");
  await expect(page.getByRole("link", { name: /Forces and motion/ })).toContainText("ready");
});

test("the tutor gets the right pages of the course for a question", async ({ page }) => {
  test.setTimeout(90_000);
  await uploadChapter(page);
  await page.getByRole("button", { name: /Start studying/ }).click();
  await page.getByRole("link", { name: "Open the course notebook" }).click();
  await expect(page).toHaveURL(/\/notebook\?course=/);
  await expect(page.getByRole("treeitem", { name: "Forces and motion" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Mock the gate and the model; capture what the tutor is given.
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "answer_question", confidence: 0.95, reason: "question" },
        source: "model",
        latencyMs: 50,
      },
    }),
  );
  const sent: { courseContext: { page: number; heading: string | null; text: string }[] }[] = [];
  await page.route("**/api/tutor", (route) => {
    sent.push(route.request().postDataJSON() as (typeof sent)[number]);
    const speech = "Friction opposes sliding: it's on page 3.";
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          { type: "speech", text: speech, latencyMs: 100 },
          { type: "response", response: { speech, actions: [] }, latencyMs: 200 },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
    });
  });
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(4800) }),
  );

  // The dev server compiles a route on its first call, which can outlast the tutor's 2.5 s wait
  // for course pages: call it once first (a production build has nothing to compile).
  const courseId = new URL(page.url()).searchParams.get("course");
  await page.evaluate(
    (id) =>
      fetch(`/api/courses/${id}/retrieve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "friction", k: 1 }),
      }).then((r) => r.status),
    courseId,
  );

  await page.getByRole("button", { name: "Debug panel" }).click();
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill("why does friction slow a sliding box down?");
  await input.press("Enter");

  await expect.poll(() => sent.length, { timeout: 15_000 }).toBe(1);
  const context = sent[0]?.courseContext ?? [];
  expect(context.length).toBeGreaterThan(0);
  expect(context[0]).toMatchObject({ page: 3, heading: "3.3 Friction" });
  expect(context[0]?.text).toContain("opposes sliding");
});
