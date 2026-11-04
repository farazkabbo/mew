import { expect, type Page, test } from "./fixtures";

import { CHAPTER, makePdf } from "./helpers/pdf";

/**
 * M8: attempts with evidence, concept statuses, FSRS reviews, exam planning and "Quiz me".
 * Runs against the real API service (local course store, no model keys). Lessons and grading
 * are model calls, so they are mocked here; recording attempts and scheduling are real.
 */

const DB_NAME = "mew-notebooks-local";

const LESSON = {
  explanation: "Friction opposes sliding between surfaces (see p. 3).",
  worked_example: "",
  practice: [
    {
      question: "Which way does friction act on a sliding box?",
      answer: "Opposite to its motion.",
      hint: "Think about what brakes do.",
    },
    {
      question: "Name one thing that changes how much friction there is.",
      answer: "The surfaces in contact, or how hard they press together.",
      hint: "",
    },
  ],
  pages: [3],
  generated: true,
};

test.beforeEach(async ({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
  await page.route("**/api/courses/*/concepts/*/lesson", (route) =>
    route.fulfill({ json: LESSON }),
  );
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(4800) }),
  );
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "ignore", confidence: 0.9, reason: "nothing asked" },
        source: "model",
        latencyMs: 50,
      },
    }),
  );
  await page.route("**/api/recognize", (route) =>
    route.fulfill({
      json: { text: "against the motion", latex: null, subject: "physics", confidence: 0.9 },
    }),
  );
});

/** YYYY-MM-DD, `days` from today (local time, like the date input). */
function dateIn(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function startCourse(page: Page, examDate?: string) {
  await page.goto("/courses");
  await page.locator('input[type="file"]').setInputFiles({
    name: "chapter-3.pdf",
    mimeType: "application/pdf",
    buffer: makePdf(CHAPTER),
  });
  await page.getByLabel("Course title").fill("Forces and motion");
  await page.getByRole("button", { name: "Build course" }).click();
  await expect(page.getByText("Needs review")).toBeVisible({ timeout: 30_000 });
  if (examDate) await page.getByLabel("Exam date (optional)").fill(examDate);
  await page.getByRole("button", { name: /Start studying/ }).click();
  await expect(page.getByTestId("plan-concept")).toHaveCount(3);
  return page.url();
}

const planRow = (page: Page, title: string) =>
  page.getByTestId("plan-concept").filter({ hasText: title });

async function writeLetters(page: Page, x: number, y: number, count: number, size = 28) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  for (let i = 0; i < count; i++) {
    const left = box.x + x + i * size * 0.9;
    await page.mouse.move(left, box.y + y + size);
    await page.mouse.down();
    await page.mouse.move(left + size * 0.3, box.y + y, { steps: 4 });
    await page.mouse.move(left + size * 0.6, box.y + y + size, { steps: 4 });
    await page.mouse.up();
  }
}

async function tutorStrokeCount(page: Page): Promise<number> {
  return page.evaluate(
    (name) =>
      new Promise<number>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(open.error ?? new Error("open failed"));
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction("strokes").objectStore("strokes").getAll();
          request.onsuccess = () => {
            const strokes = request.result as { author: string }[];
            resolve(strokes.filter((s) => s.author === "tutor").length);
            db.close();
          };
        };
      }),
    DB_NAME,
  );
}

test("practice moves a concept from not started to checked, with a plan and reviews", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await startCourse(page, dateIn(4));

  // Nothing started yet; the exam plan spreads the three concepts over the days left.
  await expect(page.getByTestId("concept-status")).toHaveText([
    "Not started",
    "Not started",
    "Not started",
  ]);
  await expect(page.getByTestId("plan-summary")).toContainText("0 checked · exam in 4 days");
  const days = page.getByTestId("plan-day");
  await expect(days.first()).toContainText("Today");
  await expect(days.first()).toContainText("Work on: Forces");
  await expect(days.last()).toContainText("Final review of everything");

  // A lesson: the first answer comes after the hint, the second on the student's own.
  await planRow(page, "Friction").getByRole("link", { name: "Friction" }).click();
  const questions = page.getByTestId("practice-question");
  await expect(questions).toHaveCount(2);
  await questions.nth(0).getByRole("button", { name: "Show hint" }).click();
  await expect(questions.nth(0)).toContainText("Think about what brakes do.");
  await questions.nth(0).getByRole("button", { name: "Check my answer" }).click();
  await expect(questions.nth(0)).toContainText("Opposite to its motion.");
  await questions.nth(0).getByRole("button", { name: "I had it" }).click();
  await expect(questions.nth(0)).toContainText("Recorded: correct with a hint.");
  await expect(page.getByTestId("concept-status")).toHaveText("Practised with hint");

  await questions.nth(1).getByRole("button", { name: "Check my answer" }).click();
  await questions.nth(1).getByRole("button", { name: "I had it" }).click();
  await expect(page.getByTestId("concept-status")).toHaveText("Checked");

  // Back on the plan: checked, with its next review scheduled by FSRS (3 days for a first
  // independent answer).
  await page.getByRole("link", { name: "Forces and motion" }).click();
  await expect(planRow(page, "Friction").getByTestId("concept-status")).toHaveText("Checked");
  await expect(planRow(page, "Friction")).toContainText("review in 3 days");
  await expect(page.getByTestId("plan-summary")).toContainText("1 checked");
  await expect(days.first()).not.toContainText("Friction");

  // Opening a lesson puts its concept in the review queue; Friction isn't due yet.
  const explored = page.waitForResponse((r) => r.url().endsWith("/explored"));
  await planRow(page, "Forces").getByRole("link", { name: "Forces" }).click();
  expect((await explored).status()).toBe(204);
  await expect(page.getByTestId("practice-question")).toHaveCount(2);
  await expect(page.getByTestId("concept-status")).toHaveCount(0);
  // (Other tests' courses share this API's store: look at this course only.)
  const courseId = new URL(page.url()).pathname.split("/")[2] ?? "";
  await page.goto("/review");
  // Each course is a folder (decision U25): bring this one to the front by its tab.
  await page.locator(`#folder-tab-${courseId}`).click();
  const section = page.locator(`#folder-${courseId}`);
  await expect(section.locator(`a[href="/courses/${courseId}"]`)).toBeVisible();
  // The folder lists every concept started: new first, then the checked one (Friction).
  const items = section.getByTestId("review-item");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("Forces");
  await expect(items.first()).toContainText("Not practised yet");
  await expect(items.first()).toContainText("New");
  await expect(items.last()).toContainText("Friction");
  await expect(items.last()).toContainText("Checked");
  // Quiz me asks about what's due: Forces only.
  await expect(section.getByRole("link", { name: /Quiz me/ })).toContainText("1");
});

test("Quiz me asks in the notebook, grades the written answer and records the evidence", async ({
  page,
}) => {
  test.setTimeout(90_000);
  let verdict: "correct" | "incorrect" = "correct";
  const graded: {
    question: string;
    expected: string;
    recognized: string[];
    image: string | null;
  }[] = [];
  await page.route("**/api/quiz/grade", (route) => {
    graded.push(route.request().postDataJSON() as (typeof graded)[number]);
    return route.fulfill({
      json:
        verdict === "correct"
          ? { verdict, feedback: "Yes: it acts against the motion.", note: "" }
          : { verdict, feedback: "Which way is the box moving?", note: "direction?" },
    });
  });
  const courseUrl = await startCourse(page);
  await page.getByRole("link", { name: "Quiz me" }).click();
  await expect(page).toHaveURL(/\/notebook\?course=.*&quiz=1/);

  const card = page.getByTestId("quiz-card");
  await expect(card).toContainText("Quiz · Forces and motion");
  // New course: concepts in course order, the first one's first practice question.
  await expect(card).toContainText("Forces");
  await expect(page.getByTestId("quiz-question")).toHaveText(LESSON.practice[0]?.question ?? "");

  await card.getByRole("button", { name: "Check my answer" }).click();
  await expect(card).toContainText("Write or say your answer first");
  expect(graded).toHaveLength(0);

  await writeLetters(page, 520, 300, 4);
  await card.getByRole("button", { name: "Check my answer" }).click();
  await expect(page.getByTestId("quiz-feedback")).toHaveText("Yes: it acts against the motion.");
  await expect(page.getByTestId("quiz-score")).toHaveText("1 of 1 right");
  await expect(card.getByTestId("concept-status")).toHaveText("Checked");
  expect(graded[0]).toMatchObject({
    question: LESSON.practice[0]?.question,
    expected: LESSON.practice[0]?.answer,
    recognized: ["against the motion"],
  });
  expect(graded[0]?.image?.length).toBeGreaterThan(100);
  // The answer is ticked in tutor ink.
  await expect.poll(() => tutorStrokeCount(page), { timeout: 10_000 }).toBeGreaterThan(0);

  // Next concept: a wrong first try gets a hint; the corrected answer counts "with hint".
  await card.getByRole("button", { name: "Next question" }).click();
  await expect(card).toContainText("Newtons Laws");
  verdict = "incorrect";
  await writeLetters(page, 520, 400, 3);
  await card.getByRole("button", { name: "Check my answer" }).click();
  await expect(page.getByTestId("quiz-feedback")).toHaveText("Which way is the box moving?");
  verdict = "correct";
  await writeLetters(page, 520, 470, 3);
  await card.getByRole("button", { name: "Check my answer" }).click();
  await expect(card.getByTestId("concept-status")).toHaveText("Practised with hint");
  await expect(page.getByTestId("quiz-score")).toHaveText("2 of 2 right");

  await card.getByRole("button", { name: "End quiz" }).click();
  await expect(card).toHaveCount(0);

  await page.goto(courseUrl);
  await expect(page.getByTestId("concept-status")).toHaveText([
    "Checked",
    "Practised with hint",
    "Not started",
  ]);
});

test("without a grader, the student compares with the model answer themselves", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await startCourse(page);
  await page.getByRole("link", { name: "Open the course notebook" }).click();

  // "Quiz me" from Ctrl+K's commands, in the course's own notebook.
  await expect(page.getByTestId("pencil-case")).toBeVisible();
  await page.keyboard.press("Control+KeyK");
  await page.keyboard.type(">quiz");
  await page.getByRole("option", { name: /Quiz me on this course/ }).click();
  const card = page.getByTestId("quiz-card");
  await expect(page.getByTestId("quiz-question")).toHaveText(LESSON.practice[0]?.question ?? "");
  await writeLetters(page, 520, 300, 4);
  // No model key in this test server: /api/quiz/grade answers 503.
  await card.getByRole("button", { name: "Check my answer" }).click();
  await expect(card).toContainText("Compare with the model answer");
  await expect(card).toContainText("Opposite to its motion.");
  await card.getByRole("button", { name: "Not quite" }).click();
  // Wrong and never right before: still only explored, and back for another go.
  await expect(card.getByTestId("concept-status")).toHaveText("Explored");
  await expect(page.getByTestId("quiz-score")).toHaveText("0 of 1 right");
});
