import { expect, type Page, test } from "./fixtures";
import { CHAPTER, makePdf } from "./helpers/pdf";

/**
 * The guided tour (NEB_APP_UI decision U32): neb's card sits over the real app, points at the
 * real control with a ring and an arrow, and moves on when the student has done the thing.
 */

const SHOTS = "../design/u/screenshots/tour";

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    throw error;
  });
});

const guide = (page: Page) => page.getByTestId("tour-guide");
const onStep = (page: Page, id: string) => expect(guide(page)).toHaveAttribute("data-step", id);
const press = (page: Page, name: string) =>
  guide(page).getByRole("button", { name, exact: true }).click();

async function setSettings(page: Page, settings: object) {
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
  const response = await page.request.patch(`${origin}/api/settings`, {
    data: settings,
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
}

/** The ring is on `target`, and the arrow is drawn. */
async function pointsAt(page: Page, target: ReturnType<Page["locator"]>) {
  await expect(page.getByTestId("tour-arrow")).toBeVisible();
  await expect
    .poll(async () => {
      const ring = await page.getByTestId("tour-ring").boundingBox();
      const box = await target.boundingBox();
      if (!ring || !box) return "missing";
      return Math.abs(ring.x + 6 - box.x) < 3 && Math.abs(ring.y + 6 - box.y) < 3 ? "on" : "off";
    })
    .toBe("on");
}

/** From the welcome to Review, by doing each real thing. */
async function throughReview(page: Page, total: number, importPdf: boolean) {
  await onStep(page, "welcome");
  await expect(guide(page)).toContainText(`step 1 of ${total}`);
  await press(page, "Start");

  // A real notebook: the card waits for it, and can't be "Next"-ed past.
  await onStep(page, "notebook");
  const newNotebook = page.locator('[data-tour="new-notebook"]');
  await pointsAt(page, newNotebook);
  await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/notebook.png` });
  await newNotebook.click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  // The card stays readable over the app's own dialog.
  await expect(guide(page).getByRole("heading", { name: "Make a notebook" })).toBeVisible();
  await dialog.getByLabel("Name").fill("Tour physics");
  await dialog.getByRole("button", { name: "Create" }).click();

  // A notebook without chapters opens on its first page, so "Open a page" is already done.
  // Writing is paced by the student: Next waits for a stroke, then for them.
  await onStep(page, "write");
  await expect(page.getByTestId("tour-ring")).toBeVisible();
  await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  const sheet = await page.getByTestId("notebook-canvas").boundingBox();
  if (!sheet) throw new Error("no page");
  await page.mouse.move(sheet.x + 180, sheet.y + 200);
  await page.mouse.down();
  await page.mouse.move(sheet.x + 300, sheet.y + 220, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId("tour-ready")).toContainText("Carry on when");
  await page.waitForTimeout(600);
  await onStep(page, "write"); // still here: nothing moved on by itself
  await press(page, "Next");

  await onStep(page, "marks");
  await pointsAt(page, page.getByTestId("level-switch"));
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/marks.png` });
  await press(page, "Next");

  // The real keys: hold, then let go.
  await onStep(page, "ask");
  await expect(guide(page)).toContainText("uses one of your free ones");
  await page.keyboard.down("ControlLeft");
  await page.keyboard.down("AltLeft");
  await page.waitForTimeout(500);
  await page.keyboard.up("AltLeft");
  await page.keyboard.up("ControlLeft");
  // The answer has time to play: the card stays until the student carries on.
  await expect(page.getByTestId("tour-ready")).toBeVisible();
  await onStep(page, "ask");
  await press(page, "Next");

  // Round the app with its own controls: the notebook's name, then the back arrow.
  await onStep(page, "to-home");
  const crumb = page.getByTestId("breadcrumb").getByRole("button").first();
  await pointsAt(page, crumb);
  await crumb.click();

  await onStep(page, "home");
  await expect(page.getByRole("heading", { name: "Tour physics" })).toBeVisible();
  await pointsAt(page, page.getByRole("tablist", { name: "Notebook" }));
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/home.png` });
  await press(page, "Next");

  await onStep(page, "pdf");
  await pointsAt(page, page.getByTestId("add-material"));
  await expect(guide(page)).toContainText("No PDF to hand?");
  if (importPdf) {
    // A real import, as course material: the PDF arriving moves on, closing the dialog doesn't.
    await page.getByTestId("add-material").getByRole("button").first().click();
    const importing = page.getByRole("dialog", { name: "Import a PDF" });
    await importing.locator('input[type="file"]').setInputFiles({
      name: "chapter-3.pdf",
      mimeType: "application/pdf",
      buffer: makePdf(CHAPTER),
    });
    await expect(importing).toContainText("3 pages");
    await importing.getByRole("button", { name: "Import", exact: true }).click();

    // The import opens the PDF's first page: back to the notebook with its own name.
    await expect(guide(page)).toHaveAttribute("data-step", "back-home", { timeout: 30_000 });
    await page.getByTestId("breadcrumb").getByRole("button").first().click();

    await onStep(page, "study-tab");
    const study = page.getByRole("tab", { name: "Study" });
    await pointsAt(page, study);
    await study.click();

    // neb reads the PDF; the card carries on by itself when the topics are there.
    await expect(guide(page)).toHaveAttribute("data-step", "topics", { timeout: 30_000 });
    const start = page.getByRole("button", { name: /Start studying/ });
    await pointsAt(page, start);
    await start.click();

    await onStep(page, "quiz");
    const quizMe = page.getByRole("button", { name: "Quiz me" });
    await pointsAt(page, quizMe);
    await page.waitForTimeout(450); // the card has arrived
    await page.screenshot({ path: `${SHOTS}/quiz.png` });
    await quizMe.click();

    // The quiz is the student's to pace: Next waits for a marked answer.
    await onStep(page, "answer");
    const card = page.getByTestId("quiz-card");
    await expect(card).toBeVisible();
    await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(0);
    await expect(page.getByTestId("quiz-question")).toBeVisible();
    const canvas = await page.getByTestId("notebook-canvas").boundingBox();
    if (!canvas) throw new Error("no page");
    for (let i = 0; i < 4; i++) {
      const left = canvas.x + 520 + i * 26;
      await page.mouse.move(left, canvas.y + 328);
      await page.mouse.down();
      await page.mouse.move(left + 9, canvas.y + 300, { steps: 4 });
      await page.mouse.move(left + 18, canvas.y + 328, { steps: 4 });
      await page.mouse.up();
    }
    await card.getByRole("button", { name: "Check my answer" }).click();
    await expect(page.getByTestId("quiz-feedback")).toHaveText("Yes, that's it.");
    await expect(page.getByTestId("tour-ready")).toBeVisible();
    await expect(card.getByTestId("concept-status")).toHaveText("Checked");
    await card.getByRole("button", { name: "End quiz" }).click();
    await press(page, "Next");
  } else {
    // Without a PDF there's no quiz to take: skipping goes past all of it.
    await press(page, "Skip this step");
  }

  await onStep(page, "to-desk");
  const back = page.getByRole("button", { name: "Back to the desk" });
  await pointsAt(page, back);
  await back.click();

  await onStep(page, "review-open");
  await pointsAt(page, page.getByTestId("desk-review"));
  await page.getByTestId("desk-review").click();

  await onStep(page, "review");
  if (importPdf) {
    // What was just practised has a folder.
    await expect(page.getByTestId("review-folders")).toContainText("Tour physics");
    await expect(page.getByTestId("tour-ring")).toBeVisible();
    await page.waitForTimeout(450); // the card has arrived
    await page.screenshot({ path: `${SHOTS}/review.png` });
  }
  await press(page, "Next");
}

test("the tour walks the real app: a notebook, a page, writing, asking, a PDF, a quiz and Review", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.route("**/api/quiz/grade", (route) =>
    route.fulfill({ json: { verdict: "correct", feedback: "Yes, that's it.", note: "" } }),
  );
  await page.goto("/tour");
  await expect(page).toHaveURL(/\/desk$/);
  await throughReview(page, 19, true);

  await onStep(page, "done");
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/done.png` });
  await press(page, "Finish");
  await expect(guide(page)).toHaveCount(0);

  // What was made is real, and kept.
  await page.goto("/desk");
  await expect(page.getByTestId("desk-cover").first()).toBeVisible();
});

test("in the Windows app the tour goes on to Screen Coach, the island and circling", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = { coach: false };
    Object.assign(window, {
      __tourCoach: state,
      __TAURI_INTERNALS__: {},
      __TAURI__: {
        core: {
          invoke: (command: string, args?: { openSettings?: boolean }) => {
            if (command !== "screen_coach_onboarding") return Promise.resolve(null);
            // Opening its settings is where the student turns it on.
            if (args?.openSettings) state.coach = true;
            return Promise.resolve(state.coach);
          },
        },
      },
    });
  });
  await page.goto("/tour");
  await throughReview(page, 23, false);

  // Screen Coach: the card waits until the Windows app says it's on.
  await onStep(page, "coach");
  await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  await press(page, "Open its settings");
  await expect(page.getByTestId("tour-ready")).toContainText("Screen Coach is on.");
  await press(page, "Next");

  await onStep(page, "island");
  await press(page, "I see it");

  // Circling is done with the Windows app; it tells the page when a question was asked.
  await onStep(page, "circle");
  await expect(guide(page)).toContainText("pick the selection tool");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("mew:screen-entry-saved")));
  await expect(page.getByTestId("tour-ready")).toBeVisible();
  await press(page, "Next");

  await onStep(page, "moments");
  await press(page, "Take me there");
  await onStep(page, "moments");
  await press(page, "Next");

  await onStep(page, "done");
  await press(page, "Finish");
  await expect(guide(page)).toHaveCount(0);
});

test("someone new is shown round once; the tour survives a reload and can be ended", async ({
  page,
}) => {
  await page.goto("/desk");
  await page.evaluate(() => window.localStorage.clear());
  await setSettings(page, { onboarded: false });
  await page.reload();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.keyboard.press("Escape");
  await onStep(page, "welcome");
  await expect(page).toHaveURL(/\/desk$/);
  await press(page, "Start");
  await onStep(page, "notebook");

  // F5 keeps the step; Back goes to the one before.
  await page.reload();
  await onStep(page, "notebook");
  await press(page, "Back");
  await onStep(page, "welcome");
  await press(page, "End tour");
  await expect(guide(page)).toHaveCount(0);

  // Not again: the introduction shown a second time stays on the desk, with no tour.
  await setSettings(page, { onboarded: false });
  await page.reload();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("desk")).toBeVisible();
  await expect(guide(page)).toHaveCount(0);

  // The desk's menu has the tour and the guide.
  await page.getByRole("button", { name: "Your account and more" }).click();
  await expect(page.getByRole("menuitem", { name: "Take the tour" })).toHaveAttribute(
    "href",
    "/tour",
  );
  await expect(page.getByRole("menuitem", { name: "How to use neb" })).toBeVisible();
});
