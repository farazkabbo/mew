import { expect, type Page, test } from "./fixtures";

/**
 * The guided tour (NEB_APP_UI decisions U32 and U34): five steps over the real app. neb's card
 * points at the real control with a ring and an arrow, and moves on when the student has done
 * the thing.
 */

const SHOTS = "test-results/tour";

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

/** A real notebook: the card waits for it, and can't be "Next"-ed past. */
async function makeNotebook(page: Page, total: number) {
  await onStep(page, "notebook");
  await expect(guide(page)).toContainText(`step 1 of ${total}`);
  const newNotebook = page.locator('[data-tour="new-notebook"]');
  await pointsAt(page, newNotebook);
  await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/notebook.png` });
  await newNotebook.click();
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  // The card stays readable over the app's own dialog.
  await expect(
    guide(page).getByRole("heading", { name: "Make your first notebook" }),
  ).toBeVisible();
  await dialog.getByLabel("Name").fill("Tour physics");
  await dialog.getByRole("button", { name: "Create" }).click();
}

/** Quizzes on the notebook's home, then Review on the desk, each reached by the app's own way. */
async function quizThenReview(page: Page) {
  // On the page, the card rings the notebook's name: the way to its home.
  await onStep(page, "quiz");
  await expect(guide(page)).toContainText("Press the notebook's name up here");
  const crumb = page.getByTestId("breadcrumb").getByRole("button").first();
  await pointsAt(page, crumb);
  await crumb.click();
  await onStep(page, "quiz");
  await expect(page.getByRole("heading", { name: "Tour physics" })).toBeVisible();
  await pointsAt(page, page.getByTestId("add-material"));
  await expect(guide(page)).toContainText("Quiz me");
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/quiz.png` });
  await press(page, "Next");

  // Review is on the desk: pressing the real button finishes the step.
  // On the notebook's home, it rings the back arrow: the way to the desk.
  await onStep(page, "review");
  const back = page.getByRole("button", { name: "Back to the desk" });
  await pointsAt(page, back);
  await back.click();
  await onStep(page, "review");
  await pointsAt(page, page.getByTestId("desk-review"));
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/review.png` });
  await page.getByTestId("desk-review").click();
  await expect(page).toHaveURL(/\/review$/);

  await onStep(page, "done");
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/done.png` });
  await press(page, "Finish");
  await expect(guide(page)).toHaveCount(0);
}

test("the tour is five steps over the real app: a notebook, asking, quizzes and Review", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/tour");
  await expect(page).toHaveURL(/\/desk$/);
  await makeNotebook(page, 5);

  // A notebook without chapters opens on its first page: write, then hold Ctrl + Alt to ask.
  await onStep(page, "ask");
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  await expect(guide(page)).toContainText(mac ? "Tap the neb dot" : "Hold Ctrl + Alt");
  await expect(guide(page)).toContainText("uses one of your free ones");
  await expect(page.getByTestId("tour-ring")).toBeVisible();
  await press(page, "Next");

  await quizThenReview(page);

  // What was made is real, and kept.
  await page.goto("/desk");
  await expect(page.getByTestId("desk-cover").first()).toBeVisible();
});

test("in the Windows app the tour shows the island, its modes and Watch instead", async ({
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
  await makeNotebook(page, 5);

  // The island needs Screen Coach: the card waits until the Windows app says it's on.
  await onStep(page, "island");
  await expect(guide(page)).toContainText("Quiet, Hint, Coach, or Answer");
  await expect(guide(page)).toContainText("Press the eye");
  await expect(guide(page).getByRole("button", { name: "Next" })).toHaveCount(0);
  await press(page, "Open its settings");
  await expect(page.getByTestId("tour-ready")).toContainText("Screen Coach is on.");
  await page.waitForTimeout(450); // the card has arrived
  await page.screenshot({ path: `${SHOTS}/island.png` });
  await press(page, "Next");

  await quizThenReview(page);
});

test("an installed app without Screen Coach resumes on the notebook ask step", async ({ page }) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {},
      __TAURI__: {
        core: {
          invoke: (command: string) =>
            command === "screen_coach_onboarding"
              ? Promise.reject("Command screen_coach_onboarding not allowed by ACL")
              : Promise.resolve(null),
        },
      },
    });
    if (sessionStorage.getItem("tour-fixture-started")) return;
    sessionStorage.setItem("tour-fixture-started", "1");
    localStorage.setItem(
      "neb.tour",
      JSON.stringify({ stepId: "island", nodeId: null, pageId: null }),
    );
  });

  await page.goto("/desk");
  await onStep(page, "ask");
  await expect(guide(page)).toContainText("Tap the neb dot");
  await expect(guide(page).getByRole("button", { name: "Open its settings" })).toHaveCount(0);
  await press(page, "Next");
  await onStep(page, "quiz");

  await page.goto("/guide");
  await expect(page.getByTestId("guide")).toContainText("Turn a PDF into lessons and a quiz");
});

test("someone new is shown round once; the tour survives a reload and can be ended", async ({
  page,
}) => {
  await page.goto("/desk");
  await page.evaluate(() => window.localStorage.clear());
  await setSettings(page, { onboarded: false });
  await page.reload();
  // The introduction is only the handwriting now; skipping it starts the tour on the desk.
  const intro = page.getByTestId("onboarding");
  await expect(intro.getByRole("heading", { name: "Teach neb your handwriting" })).toBeVisible();
  await page.keyboard.press("Escape");
  await onStep(page, "notebook");
  await expect(page).toHaveURL(/\/desk$/);

  // F5 keeps the step.
  await page.reload();
  await onStep(page, "notebook");
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
