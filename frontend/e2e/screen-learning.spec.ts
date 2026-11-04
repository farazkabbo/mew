import { expect, test } from "./fixtures";

/**
 * Screen Coach S5 and S6, the web app's side: the review lists the skills learned in coach mode
 * with their re-checks (and forgets one), and a "quiz me on this" card is answered in the Quick
 * check like a moment's, saying which screen it came from.
 *
 * Making skills and quiz cards (the evidence rule, FSRS, the keys' verification, the daily cap)
 * is covered by the backend's, the database's and the web server's tests; here their routes are
 * mocked.
 */

const day = 86_400_000;
const PIVOT = "11111111-1111-4111-8111-111111111111";
const CHARTS = "22222222-2222-4222-8222-222222222222";
const QUIZ_CARD = "33333333-3333-4333-8333-333333333333";

function skill(id: string, title: string, dueIn: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    app: "excel.exe",
    conceptTitle: null,
    dueAt: new Date(Date.now() + dueIn).toISOString(),
    lastEvidence: "with_hint",
    lastHints: 2,
    lastAt: new Date(Date.now() - 2 * day).toISOString(),
    solo: 0,
    ...extra,
  };
}

test("S5: the review lists skills to re-check on the computer, and forgets one", async ({
  page,
}) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/moments/checks", (route) => route.fulfill({ json: { checks: [] } }));
  await page.route("**/api/skills", (route) =>
    route.fulfill({
      json: {
        skills: [
          skill(CHARTS, "Charts", 3 * day),
          skill(PIVOT, "Pivot tables", -day, {
            conceptTitle: "Summarising data",
            lastEvidence: "independent",
            solo: 1,
          }),
        ],
      },
    }),
  );
  const deleted: string[] = [];
  await page.route("**/api/skills/*", (route) => {
    deleted.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.fulfill({ status: 204 });
  });

  await page.goto("/review");
  const section = page.getByTestId("review-skills");
  await expect(section).toContainText("Skills to re-check");
  await expect(section).toContainText("1 skill is due");
  await expect(section).toContainText("let me try pivot tables on my own");
  const rows = section.getByTestId("review-skill");
  await expect(rows).toHaveCount(2);
  // Due first, with what it's part of and how it went.
  await expect(rows.first()).toContainText("Pivot tables");
  await expect(rows.first()).toContainText("Part of Summarising data");
  await expect(rows.first()).toContainText("Last time: done on your own");
  await expect(rows.first()).toContainText("once alone");
  await expect(rows.last()).toContainText("in 3 days");

  await page.getByRole("button", { name: "Forget Charts" }).click();
  await expect(rows).toHaveCount(1);
  expect(deleted).toEqual([`DELETE /api/skills/${CHARTS}`]);
});

test("S6: a quiz-me-on-this card comes back in the Quick check, from its screen", async ({
  page,
}) => {
  await page.route("**/api/review", (route) => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/skills", (route) => route.fulfill({ json: { skills: [] } }));
  await page.route("**/api/moments/checks", (route) =>
    route.fulfill({
      json: {
        checks: [
          {
            id: QUIZ_CARD,
            clipId: null,
            origin: "screen_quiz",
            sourceTitle: "Lecture 5 - Projectile motion",
            mergedClipIds: [],
            nodeId: null,
            prompt: "What is the horizontal acceleration of a projectile?",
            kind: "mcq",
            choices: ["0", "9.8 m/s²", "It depends on the angle"],
            conceptHints: ["projectile motion"],
            isNew: true,
            dueAt: new Date(Date.now() - 60_000).toISOString(),
            createdAt: new Date(Date.now() - day).toISOString(),
          },
        ],
      },
    }),
  );
  const answers: unknown[] = [];
  await page.route(`**/api/moments/checks/${QUIZ_CARD}/answer`, (route) => {
    answers.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        correct: true,
        evidence: "independent",
        answerKey: "0",
        feedback: "That's it.",
        nextDue: new Date(Date.now() + 3 * day).toISOString(),
      },
    });
  });

  await page.goto("/review");
  await expect(page.getByTestId("review-moments")).toContainText("1 quick check");
  await page.getByTestId("review-moments").getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("quick-check-question")).toContainText("horizontal acceleration");
  // Nothing was saved, so there's no moment to show: only where it came from, after answering.
  await expect(page.getByTestId("quick-check-source")).toHaveCount(0);
  await page.getByRole("button", { name: "0", exact: true }).click();
  await expect(page.getByTestId("quick-check-result")).toContainText("That's it.");
  await expect(page.getByTestId("quick-check-source")).toHaveText(
    "From your screen: Lecture 5 - Projectile motion",
  );
  await expect(page.getByTestId("quick-check-moments")).toHaveCount(0);
  expect(answers).toEqual([{ answer: "0", peeked: false, hinted: false }]);
});
