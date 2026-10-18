import { expect, type Page, test } from "@playwright/test";

const SPEECH = "Look at the directions of the two forces. What do you notice?";

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

/** `seconds` of a quiet 220 Hz tone as 24 kHz s16le PCM (what /api/tts streams). */
function tone(seconds: number): Buffer {
  const samples = Math.round(24_000 * seconds);
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 24_000) * 3000), i * 2);
  }
  return pcm;
}

type TutorCall = {
  intent: string;
  lastUtterance: string;
  pageImage: string | null;
  recognizedLines: unknown[];
};

/** Fakes the gate (always answer) and the tutor + voice; returns the tutor requests seen. */
async function fakeBackends(page: Page, audioSeconds: number): Promise<TutorCall[]> {
  const calls: TutorCall[] = [];
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "answer_question", confidence: 0.95, reason: "direct question" },
        source: "model",
        latencyMs: 150,
      },
    }),
  );
  await page.route("**/api/tutor", async (route) => {
    calls.push(route.request().postDataJSON() as TutorCall);
    const events = [
      { type: "speech", text: SPEECH, latencyMs: 450 },
      {
        type: "response",
        response: {
          speech: SPEECH,
          actions: [
            { type: "write_math", latex: "F_1 = -F_2", anchor: { near: "below_active_line" } },
          ],
        },
        latencyMs: 900,
      },
    ];
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    });
  });
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: tone(audioSeconds) }),
  );
  await page.route("**/api/recognize", (route) =>
    route.fulfill({ json: { text: "F1 + F2 = 0", latex: "F_1 + F_2 = 0", subject: "physics" } }),
  );
  return calls;
}

async function openNotebook(page: Page) {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
}

async function write(page: Page, y: number) {
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");
  await page.mouse.move(box.x + 200, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 320, box.y + y + 10, { steps: 8 });
  await page.mouse.up();
}

async function ask(page: Page, text: string) {
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill(text);
  await input.press("Enter");
}

const mascot = (page: Page) => page.locator("[data-mascot-state]");

test("answers a question out loud and in a caption, seeing the student's handwriting", async ({
  page,
}) => {
  const calls = await fakeBackends(page, 1.5);
  await openNotebook(page);
  await write(page, 200);
  await page.getByRole("button", { name: "Debug panel" }).click();

  await ask(page, "why does the force cancel out?");

  await expect(page.getByTestId("tutor-caption")).toHaveText(SPEECH);
  await expect(mascot(page)).toHaveAttribute("data-mascot-state", "speaking");
  await expect(mascot(page)).not.toHaveAttribute("data-mascot-state", "speaking", {
    timeout: 6000,
  });

  const turn = page.getByTestId("tutor-turns").locator("li").first();
  await expect(turn).toHaveAttribute("data-outcome", "done");
  await expect(turn).toContainText("1 board action");
  await expect(turn).toContainText(/gate \d+ · speech \d+ · audio \d+( · ink \d+)? ms/);

  // The tutor saw a PNG of the handwriting.
  expect(calls).toHaveLength(1);
  expect(calls[0]?.intent).toBe("answer_question");
  expect(calls[0]?.lastUtterance).toBe("why does the force cancel out?");
  expect(
    Buffer.from(calls[0]?.pageImage ?? "", "base64")
      .subarray(1, 4)
      .toString(),
  ).toBe("PNG");
});

test("stops talking as soon as the student starts writing (barge-in)", async ({ page }) => {
  await fakeBackends(page, 8);
  await openNotebook(page);
  await page.getByRole("button", { name: "Debug panel" }).click();

  await ask(page, "what's the difference between mass and weight?");
  await expect(mascot(page)).toHaveAttribute("data-mascot-state", "speaking");

  const started = Date.now();
  await write(page, 300);
  await expect(mascot(page)).not.toHaveAttribute("data-mascot-state", "speaking");
  expect(Date.now() - started).toBeLessThan(2000);
  await expect(page.getByTestId("tutor-turns").locator("li").first()).toHaveAttribute(
    "data-outcome",
    "interrupted",
  );
});

test("recognises a line in the background after a writing pause", async ({ page }) => {
  await fakeBackends(page, 1);
  const recognised = page.waitForRequest("**/api/recognize");
  await openNotebook(page);

  await write(page, 200);

  const request = await recognised;
  const { image } = request.postDataJSON() as { image: string };
  expect(Buffer.from(image, "base64").subarray(1, 4).toString()).toBe("PNG");
});

test("apologises briefly when the real tutor isn't configured", async ({ page }) => {
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "answer_question", confidence: 0.95, reason: "question" },
        source: "model",
        latencyMs: 100,
      },
    }),
  );
  await openNotebook(page);
  await page.getByRole("button", { name: "Debug panel" }).click();

  await ask(page, "why is the sky blue?");

  await expect(page.getByTestId("tutor-caption")).toContainText("couldn't answer");
  await expect(page.getByTestId("tutor-turns").locator("li").first()).toHaveAttribute(
    "data-outcome",
    "failed",
  );
});
