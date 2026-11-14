import { expect, type Page, test } from "./fixtures";

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
async function throughReview(page: Page, total: number) {
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
  // Writing on the real page moves on.
  await onStep(page, "write");
  await expect(page.getByTestId("tour-ring")).toBeVisible();
  const sheet = await page.getByTestId("notebook-canvas").boundingBox();
  if (!sheet) throw new Error("no page");
  await page.mouse.move(sheet.x + 180, sheet.y + 200);
  await page.mouse.down();
  await page.mouse.move(sheet.x + 300, sheet.y + 220, { steps: 6 });
  await page.mouse.up();

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
  await press(page, "Skip this step");

  await onStep(page, "study");
  await press(page, "Next");

  await onStep(page, "to-desk");
  const back = page.getByRole("button", { name: "Back to the desk" });
  await pointsAt(page, back);
  await back.click();

  await onStep(page, "review-open");
  await pointsAt(page, page.getByTestId("desk-review"));
  await page.getByTestId("desk-review").click();

  await onStep(page, "review");
  await press(page, "Next");
}

test("the tour walks the real app: a notebook, a page, writing, asking, a PDF and Review", async ({
  page,
}) => {
  await page.goto("/tour");
  await expect(page).toHaveURL(/\/desk$/);
  await throughReview(page, 14);

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
  await throughReview(page, 18);

  // Screen Coach: the card waits until the Windows app says it's on.
  await onStep(page, "coach");
  await press(page, "Open its settings");

  await onStep(page, "island");
  await press(page, "I see it");

  // Circling is done with the Windows app; it tells the page when a question was asked.
  await onStep(page, "circle");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("mew:screen-entry-saved")));

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
