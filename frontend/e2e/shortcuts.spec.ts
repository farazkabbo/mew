import { expect, type Page, test } from "./fixtures";

/**
 * Two-key shortcuts (K2, docs/NOTEBOOKS_K.md §11): the one-time "Shortcuts got simpler" card, the
 * Settings → Shortcuts recorder (two keys max, clashes, a suggestion, reset), the student's own
 * bindings in the notebook, Alt+C, the Ctrl+Alt hold on the notebook page, and the keys Neb leaves
 * to the browser.
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

async function setSettings(page: Page, settings: object) {
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
  const response = await page.request.patch(`${origin}/api/settings`, {
    data: settings,
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
}

async function savedShortcuts(page: Page): Promise<unknown> {
  const response = await page.request.get("/api/settings");
  return ((await response.json()) as { shortcuts: unknown }).shortcuts;
}

async function openNotebook(page: Page) {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
}

test("'Shortcuts got simpler' shows once to a student who knew the old shortcuts", async ({
  page,
}) => {
  await setSettings(page, { shortcuts_notice_seen: false });
  await openNotebook(page);
  const card = page.getByTestId("shortcuts-notice");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Ctrl+Shift+Z is gone");
  await expect(card).toContainText("Ctrl+Y");
  await card.getByRole("button", { name: "Got it" }).click();
  await expect(card).toBeHidden();

  await page.reload();
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await expect(page.getByTestId("shortcuts-notice")).toBeHidden();
});

test("the recorder refuses three keys and clashes, and a new binding works in the notebook", async ({
  page,
}) => {
  await page.goto("/settings");
  const record = page.getByTestId("record-new_notebook");
  await record.click();
  await expect(record).toHaveText("Press keys…");

  await page.keyboard.press("Control+Shift+Alt+KeyX");
  await expect(page.getByRole("alert").filter({ hasText: "two keys max" })).toBeVisible();

  // Alt+N is "New chapter": refused, with a free one offered.
  await page.keyboard.press("Alt+KeyN");
  const clash = page.getByRole("alert").filter({ hasText: "New chapter in this notebook" });
  await expect(clash).toBeVisible();
  await expect(clash.getByRole("button", { name: /^Use Alt\+[A-Z]$/ })).toBeVisible();

  await page.keyboard.press("Alt+KeyJ");
  await expect(record).toHaveText("Change");
  await expect(page.getByRole("row", { name: /New notebook/ }).locator("kbd")).toHaveText("Alt+J");
  await expect.poll(() => savedShortcuts(page)).toEqual({ new_notebook: "Alt+J" });

  // In the notebook: Alt+J makes a notebook; Alt+B no longer does.
  await openNotebook(page);
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await page.keyboard.press("Alt+KeyB");
  await page.waitForTimeout(200);
  await expect(dialog).toBeHidden();
  await page.keyboard.press("Alt+KeyJ");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // Reset to defaults.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await expect.poll(() => savedShortcuts(page)).toEqual({});
  await expect(page.getByRole("row", { name: /New notebook/ }).locator("kbd")).toHaveText("Alt+B");
});

test("Alt+C checks my work, holding Ctrl+Alt asks Neb, and Alt+←/→ stay the browser's", async ({
  page,
}) => {
  const tutorCalls: { intent: string }[] = [];
  await page.route("**/api/tutor", (route) => {
    tutorCalls.push(route.request().postDataJSON() as { intent: string });
    const speech = "Nothing to check yet.";
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
  const summons: boolean[] = [];
  await page.route("**/api/mew", (route) => {
    const body = route.request().postDataJSON() as { explicitSummon?: boolean };
    summons.push(body.explicitSummon === true);
    return route.fulfill({
      json: {
        output: { label: "ignore", confidence: 0.9, reason: "nothing said" },
        source: "model",
        latencyMs: 20,
      },
    });
  });
  // No microphone in the test: listening fails quietly.
  await page.route("**/api/stt/token", (route) => route.abort());
  await openNotebook(page);

  await page.keyboard.press("Alt+KeyC");
  await expect.poll(() => tutorCalls.map((c) => c.intent)).toEqual(["check_work"]);

  // AltGr (left Ctrl + right Alt) typing "@" never asks anything.
  await page.evaluate(() => {
    const key = (type: string, code: string) =>
      window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }));
    key("keydown", "ControlLeft");
    key("keydown", "AltRight");
    key("keydown", "KeyQ");
    key("keyup", "KeyQ");
    key("keyup", "AltRight");
    key("keyup", "ControlLeft");
  });
  await page.waitForTimeout(500);
  expect(summons).toEqual([]);

  // Holding left Ctrl + left Alt, then letting go, asks Neb (like tapping the mascot).
  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  await page.waitForTimeout(450);
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await expect.poll(() => summons).toEqual([true]);

  // Alt+←/→ are the browser's Back and Forward: Neb never takes them.
  const taken = await page.evaluate(() =>
    ["ArrowLeft", "ArrowRight"].map(
      (code) =>
        !window.dispatchEvent(
          new KeyboardEvent("keydown", { code, key: code, altKey: true, cancelable: true }),
        ),
    ),
  );
  expect(taken).toEqual([false, false]);
  // …while Neb's own two-key shortcuts reach it.
  const ours = await page.evaluate(() =>
    [
      { code: "KeyY", ctrlKey: true },
      { code: "ArrowUp", altKey: true },
      // Last: it opens the jump palette (a dialog, where the others stop working).
      { code: "KeyK", ctrlKey: true },
    ].map(
      (init) =>
        !window.dispatchEvent(new KeyboardEvent("keydown", { ...init, key: "", cancelable: true })),
    ),
  );
  expect(ours).toEqual([true, true, true]);
});
