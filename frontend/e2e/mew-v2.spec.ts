import { MEW_FEATURES_VERSION } from "@mew/shared";

import { expect, type Page, test } from "./fixtures";

/**
 * M10: decisions kept only with the student's opt-in, labelled in Teach Mew, exported and
 * deleted; and the in-browser classifier (Mew v2) loading from our own origin under the
 * workers' CSP. The gate runs for real (no model key here: it decides by rule or falls back).
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

async function say(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill(text);
  await input.press("Enter");
}

test("decisions are kept only with opt-in, then labelled, exported and deleted", async ({
  page,
}) => {
  await page.goto("/teach");
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByTestId("teach-empty")).toBeVisible();
  await expect(page.getByText(/isn.t keeping new decisions/)).toBeVisible();

  // Opted out (the default): nothing is kept.
  await page.goto("/notebook");
  await page.getByRole("button", { name: "Debug panel" }).click();
  await say(page, "why does the force cancel out?");
  await expect(page.getByTestId("decisions").locator("li")).toHaveCount(1);
  await page.goto("/teach");
  await expect(page.getByTestId("teach-empty")).toBeVisible();

  // Opted in: the next decision is kept.
  await setSettings(page, { mew_logging_opt_in: true });
  await page.goto("/notebook");
  await page.getByRole("button", { name: "Debug panel" }).click();
  await say(page, "what's the difference between mitosis and meiosis?");
  await expect(page.getByTestId("decisions").locator("li")).toHaveCount(1);

  await expect
    .poll(
      async () => {
        await page.goto("/teach");
        await expect(
          page.getByTestId("mew-event").first().or(page.getByTestId("teach-empty")),
        ).toBeVisible();
        return page.getByTestId("mew-event").count();
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  const event = page.getByTestId("mew-event");
  await expect(event).toContainText("mitosis and meiosis");

  // Label it (keyboard: 2 = Answer), and it stays labelled.
  await event.focus();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes("/api/mew/events/"),
  );
  await page.keyboard.press("2");
  expect((await saved).status()).toBe(204);
  await expect(event.getByRole("button", { name: /Answer/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.reload();
  await expect(page.getByTestId("mew-event")).toHaveAttribute("data-label", "answer_question");
  await page.getByRole("checkbox", { name: "Only unlabelled" }).check();
  await expect(page.getByTestId("teach-empty")).toBeVisible();

  // The download is the dataset exporter's input.
  const origin = new URL(page.url()).origin;
  const download = await page.request.get(`${origin}/api/mew/events/export`);
  expect(download.headers()["content-disposition"]).toContain("mew-labels.jsonl");
  const rows = (await download.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { human_label: string; input: { lastUtterance: string } });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    human_label: "answer_question",
    input: { lastUtterance: "what's the difference between mitosis and meiosis?" },
  });

  // Deleting forgets everything.
  await page.getByRole("checkbox", { name: "Only unlabelled" }).uncheck();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Delete everything" }).click();
  await expect(page.getByTestId("teach-empty")).toBeVisible();
});

test("the in-browser classifier loads from our own origin, or stands aside without a model", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/notebook");
  const origin = new URL(page.url()).origin;
  const installed = (await page.request.get(`${origin}/workers/models/mew-gate/mew.json`)).ok();

  const result = await page.evaluate(
    async ({ features }) => {
      const worker = new Worker("/workers/mew-gate.mjs", { type: "module" });
      const next = () =>
        new Promise<Record<string, unknown>>((resolve) => {
          worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => resolve(event.data);
        });
      const ready = next();
      worker.postMessage({ type: "init", features });
      const state = await ready;
      if (state.type !== "ready") return { state };
      const answer = next();
      worker.postMessage({
        id: 1,
        text: "is this right? | before: - | writing: 2x + 3 = 7 | trigger utterance; summoned no; tutor spoke no; last stroke just now; erased no; lines 1",
      });
      return { state, answer: await answer };
    },
    { features: MEW_FEATURES_VERSION },
  );

  if (!installed) {
    // The usual case until a model is trained: v1 decides everything.
    expect(result.state).toMatchObject({ type: "unavailable" });
    return;
  }
  expect(result.state).toMatchObject({ type: "ready" });
  const answer = result.answer as { label: string; score: number; ms: number };
  expect([
    "ignore",
    "answer_question",
    "check_work",
    "give_hint",
    "complete_step",
    "draw_visual",
  ]).toContain(answer.label);
  expect(answer.score).toBeGreaterThan(0);
  expect(answer.score).toBeLessThanOrEqual(1);
});
