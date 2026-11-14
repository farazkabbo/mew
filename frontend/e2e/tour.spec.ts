import { expect, type Page, test } from "./fixtures";

/**
 * The interactive tour (NEB_APP_UI decision U31): every step is tried on a practice screen, the
 * Windows app gets the taskbar step, and someone new is taken to it once.
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const next = (page: Page) => page.getByRole("button", { name: "Next", exact: true });

async function setSettings(page: Page, settings: object) {
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
  const response = await page.request.patch(`${origin}/api/settings`, {
    data: settings,
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
}

/** Steps 2 to 6, the same in the browser and the Windows app (`hold`: how step 4 is done). */
async function throughSave(page: Page, hold: () => Promise<void>) {
  await expect(page.getByRole("heading", { name: "Welcome to neb" })).toBeVisible();
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // The desk: Next waits until all three parts were opened.
  await expect(next(page)).toBeDisabled();
  for (const part of ["Your notebooks", "Review", "Your initial"]) {
    await page.getByRole("button", { name: part, exact: true }).click();
  }
  await expect(page.getByText("Settings, Teach neb, and How to use neb")).toBeVisible();
  await next(page).click();

  // Writing: a stroke, a pause, then neb's mark, which changes with the level.
  const box = await page.getByLabel("Write the next line").boundingBox();
  if (!box) throw new Error("no writing box");
  await page.mouse.move(box.x + 30, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByText("Circles the slip")).toBeVisible();
  await page.getByRole("radio", { name: "Coach" }).click();
  await expect(page.getByText("Try it again.")).toBeVisible();
  await next(page).click();

  // Hold to talk.
  await expect(page.getByText("Waiting for you to hold.")).toBeVisible();
  await hold();
  await expect(page.getByText("A derivative is the slope at one point.")).toBeVisible();
  await next(page).click();

  // Circle and ask: the answer arrives in steps; another question gives another answer.
  await page.getByRole("button", { name: "Circle it for me" }).click();
  await expect(page.getByText("So acceleration is greatest at that moment.")).toBeVisible();
  await page.getByRole("radio", { name: "Give me an example" }).click();
  await expect(page.getByText("A car pulling away from a red light.")).toBeVisible();
  await next(page).click();

  // Save, then replay.
  await expect(next(page)).toBeDisabled();
  await page.getByRole("button", { name: "Save to notebook" }).click();
  await expect(page.getByTestId("tour-moment")).toBeVisible();
  await page.getByRole("button", { name: "▶ Replay" }).click();
  await expect(page.getByRole("button", { name: "▶ Replay again" })).toBeVisible();
  await next(page).click();
}

async function quizAndFinish(page: Page) {
  for (const button of [
    "Add course material",
    "Use as course material",
    "Start studying",
    "Quiz me",
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
  }
  await expect(page.getByTestId("tour-quiz")).toContainText("Why is the median a better summary");
  await next(page).click();
  await expect(page.getByRole("heading", { name: /ready/ })).toBeVisible();
  await page.getByRole("button", { name: "Open my desk" }).click();
  await expect(page).toHaveURL(/\/desk$/);
  await expect(page.getByTestId("desk")).toBeVisible();
}

test("the tour is done by trying each thing, start to finish", async ({ page }) => {
  await page.goto("/tour");
  await expect(page.getByText("1 of 8")).toBeVisible();
  await throughSave(page, async () => {
    // In the browser the real keys work.
    await page.keyboard.down("Control");
    await page.keyboard.down("Alt");
    await expect(page.getByText("Listening. Let go to ask.")).toBeVisible();
    await page.waitForTimeout(650);
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
  });
  // No taskbar step in the browser.
  await expect(page.getByRole("heading", { name: "Turn a PDF into a quiz" })).toBeVisible();
  await quizAndFinish(page);
});

test("in the Windows app the tour shows the taskbar, and never listens for real keys", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, {
      __TAURI_INTERNALS__: {},
      __TAURI__: { core: { invoke: () => Promise.resolve(null) } },
    });
  });
  await page.goto("/tour");
  await expect(page.getByText("1 of 9")).toBeVisible();
  await throughSave(page, async () => {
    // The real keys are Screen Coach's there: holding them changes nothing on this page.
    await page.keyboard.down("Control");
    await page.keyboard.down("Alt");
    await page.waitForTimeout(650);
    await page.keyboard.up("Alt");
    await page.keyboard.up("Control");
    await expect(page.getByText("Waiting for you to hold.")).toBeVisible();
    const hold = page.getByTestId("tour-hold");
    await hold.dispatchEvent("pointerdown");
    await expect(page.getByText("Listening. Let go to ask.")).toBeVisible();
    await page.waitForTimeout(650);
    await hold.dispatchEvent("pointerup");
  });

  await expect(page.getByRole("heading", { name: /Find neb in the taskbar/ })).toBeVisible();
  await page.getByRole("button", { name: "Show hidden icons" }).click();
  await page.getByRole("button", { name: "neb, in the hidden icons" }).click();
  await expect(page.getByRole("menuitem", { name: "Pause for 1 hour" })).toBeDisabled();
  await page.getByRole("menuitem", { name: "Screen Coach settings…" }).click();
  await page.getByRole("switch", { name: "Turn on Screen Coach" }).check();
  await expect(page.getByText("Screen Coach is on.")).toBeVisible();
  await expect(page.getByText("icon out of the ^ box")).toBeVisible();
  await next(page).click();
  await quizAndFinish(page);
});

test("someone new goes from the introduction to the tour, once; any step can be skipped", async ({
  page,
}) => {
  await setSettings(page, { onboarded: false });
  await page.goto("/desk");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/tour$/);
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("button", { name: "Skip this step" }).click();
  await expect(page.getByRole("heading", { name: /Write, and neb marks/ })).toBeVisible();
  await page.getByRole("button", { name: "Skip the tour" }).click();
  await expect(page).toHaveURL(/\/desk$/);

  // Not again: the introduction shown a second time stays on the desk.
  await setSettings(page, { onboarded: false });
  await page.reload();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(/\/desk$/);

  // The desk's menu has the tour and the guide.
  await page.getByRole("button", { name: "Your account and more" }).click();
  await expect(page.getByRole("menuitem", { name: "Take the tour" })).toHaveAttribute(
    "href",
    "/tour",
  );
  await expect(page.getByRole("menuitem", { name: "How to use neb" })).toBeVisible();
});
