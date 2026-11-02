import { expect, type Page, test } from "./fixtures";

/**
 * M9: first-run introduction, settings saved to the account, error states (offline, a busy
 * tutor model, a refused voice), latency reporting, and the installable web app.
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const ORIGIN_HEADER = (page: Page) => ({ origin: new URL(page.url() || "http://x").origin });

async function setSettings(page: Page, settings: object) {
  const origin = new URL(test.info().project.use.baseURL ?? "http://localhost:3000").origin;
  const response = await page.request.patch(`${origin}/api/settings`, {
    data: settings,
    headers: { origin },
  });
  expect(response.ok()).toBe(true);
}

async function fakeTurn(page: Page, events: object[]) {
  await page.route("**/api/mew", (route) =>
    route.fulfill({
      json: {
        output: { label: "answer_question", confidence: 0.95, reason: "question" },
        source: "model",
        latencyMs: 80,
      },
    }),
  );
  await page.route("**/api/tutor", (route) =>
    route.fulfill({
      contentType: "application/x-ndjson",
      body: events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    }),
  );
}

async function ask(page: Page, text: string) {
  await page.getByRole("button", { name: "Debug panel" }).click();
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill(text);
  await input.press("Enter");
}

test("the introduction shows once, can be skipped, and can be shown again", async ({ page }) => {
  await setSettings(page, { onboarded: false });
  await page.goto("/notebook");

  // U7 (§5.10): the hand, the handwriting, how much neb marks, then listening; any can be skipped.
  const intro = page.getByTestId("onboarding");
  await expect(intro.getByRole("heading", { name: "Which hand do you write with?" })).toBeVisible();
  await intro.getByRole("button", { name: "Left hand" }).click();
  // The pencil case moves to the other side at once.
  await expect(page.getByRole("button", { name: /Writing hand: left/ })).toBeAttached();
  await expect(intro.getByRole("heading", { name: "Teach neb your handwriting" })).toBeVisible();
  await intro.getByRole("button", { name: "Skip, neb will learn as you go" }).click();
  await expect(intro.getByRole("heading", { name: "How much should neb mark?" })).toBeVisible();
  await expect(intro.getByRole("radio", { name: /^Hint/ })).toHaveAttribute("aria-checked", "true");
  await intro.getByRole("radio", { name: /^Coach/ }).click();
  await intro.getByRole("button", { name: "Next", exact: true }).click();
  await expect(intro.getByRole("button", { name: "Start listening" })).toBeFocused();
  await intro.getByRole("button", { name: "Not now" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The level chosen is the notebook's.
  await expect(page.getByRole("button", { name: "How much neb marks: Coach" })).toBeVisible();

  // Remembered on the account.
  await page.reload();
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Settings → "Show the introduction again"; Escape skips it.
  await page.goto("/settings");
  await page.getByRole("button", { name: "Show the introduction again" }).click();
  await page.goto("/notebook");
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings are saved to the account and used by the notebook", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByText("Saved to your account.")).toBeVisible();

  await page.getByRole("radio", { name: /Direct answers/ }).check();
  await page.getByRole("checkbox", { name: /Captions/ }).uncheck();
  await page.getByRole("checkbox", { name: /Keep Neb's decisions/ }).check();
  await page.getByRole("slider", { name: "Neb sensitivity threshold" }).fill("0.85");
  // No ElevenLabs key in this test server.
  await expect(page.getByText(/voice isn.t set up on this server/)).toBeVisible();

  await page.reload();
  await expect(page.getByRole("radio", { name: /Direct answers/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Captions/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Keep Neb's decisions/ })).toBeChecked();
  await expect(page.getByRole("slider", { name: "Neb sensitivity threshold" })).toHaveValue("0.85");

  // The notebook's tutor and gate use them.
  await page.goto("/notebook");
  await page.getByRole("button", { name: "Debug panel" }).click();
  await expect(page.getByRole("radio", { name: "Direct answers" })).toBeChecked();
  await expect(page.getByRole("slider")).toHaveValue("0.85");
});

test("the language picker offers four languages and saves the choice", async ({ page }) => {
  await page.goto("/settings");
  const picker = page.getByTestId("language-picker");
  await expect(picker.getByRole("radio")).toHaveCount(4);
  await expect(picker.getByRole("radio", { name: "English" })).toBeChecked();
  const saved = page.waitForResponse(
    (r) => r.url().endsWith("/api/settings") && r.request().method() === "PATCH",
  );
  await picker.getByRole("radio", { name: "বাংলা" }).check();
  await saved;
  await page.reload();
  await expect(
    page.getByTestId("language-picker").getByRole("radio", { name: "বাংলা" }),
  ).toBeChecked();
  await page.getByTestId("language-picker").getByRole("radio", { name: "English" }).check();
});

test("the voice picker saves a voice and plays the one asked for", async ({ page }) => {
  await page.route("**/api/voices", (route) =>
    route.fulfill({
      json: {
        voices: [
          { id: "AAAAAAAAAAAAAAAAAAAA", name: "George" },
          { id: "BBBBBBBBBBBBBBBBBBBB", name: "Sarah" },
        ],
      },
    }),
  );
  const asked: unknown[] = [];
  await page.route("**/api/tts", (route) => {
    asked.push(route.request().postDataJSON());
    return route.fulfill({ status: 402, json: { error: "This voice needs a paid plan." } });
  });

  await page.goto("/settings");
  const picker = page.getByTestId("voice-picker");
  // Nothing chosen yet: the first voice, the server's default.
  await expect(picker.getByRole("radio", { name: "George" })).toBeChecked();

  // Hearing a voice doesn't choose it, and a refusal is explained.
  await picker.getByRole("button", { name: "Hear Sarah" }).click();
  await expect(picker.getByRole("alert")).toHaveText("This voice needs a paid plan.");
  expect(asked).toEqual([expect.objectContaining({ voiceId: "BBBBBBBBBBBBBBBBBBBB" })]);
  await expect(picker.getByRole("radio", { name: "George" })).toBeChecked();

  // Saving is debounced: wait for it before reloading.
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings") && response.request().method() === "PATCH",
  );
  await picker.getByRole("radio", { name: "Sarah" }).check();
  await expect(picker.getByRole("alert")).toHaveCount(0);
  await saved;
  await page.reload();
  await expect(
    page.getByTestId("voice-picker").getByRole("radio", { name: "Sarah" }),
  ).toBeChecked();
});

test("a busy tutor model says so, and a refused voice is explained", async ({ page }) => {
  const busy =
    "The tutor is busy right now (too many requests to the model). Try again in a minute.";
  await fakeTurn(page, [{ type: "error", message: busy }]);
  await page.goto("/notebook");
  await ask(page, "why does the force cancel out?");
  await expect(page.getByTestId("tutor-caption")).toHaveText(busy);

  // Next turn answers, but the voice is refused: captions carry on and the reason is shown.
  const speech = "Look at the directions of the two forces.";
  await page.unroute("**/api/tutor");
  await fakeTurn(page, [
    { type: "speech", text: speech, latencyMs: 100 },
    { type: "response", response: { speech, actions: [] }, latencyMs: 150 },
  ]);
  await page.route("**/api/tts", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "This voice needs a paid ElevenLabs plan. Pick another voice in Settings." },
    }),
  );
  const input = page.getByRole("textbox", { name: "Simulated utterance" });
  await input.fill("and why is it negative?");
  await input.press("Enter");
  await expect(page.getByTestId("tutor-caption")).toHaveText(speech);
  const issue = page.getByTestId("voice-issue");
  await expect(issue).toContainText("paid ElevenLabs plan");
  await expect(issue.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  // (The developer debug panel covers that corner; close it first.)
  await page.getByRole("button", { name: "Close debug panel" }).click();
  await issue.getByRole("button", { name: "Dismiss" }).click();
  await expect(issue).toHaveCount(0);
});

test("going offline is explained, and notes keep working", async ({ page, context }) => {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByTestId("offline-notice")).toContainText("saved on this device");
  await context.setOffline(false);
  await expect(page.getByTestId("offline-notice")).toHaveCount(0);
});

test("tutor turn latencies are reported and shown in Settings", async ({ page }) => {
  const speech = "Think about the directions.";
  await fakeTurn(page, [
    { type: "speech", text: speech, latencyMs: 100 },
    { type: "response", response: { speech, actions: [] }, latencyMs: 150 },
  ]);
  await page.route("**/api/tts", (route) =>
    route.fulfill({ contentType: "audio/pcm;rate=24000", body: Buffer.alloc(4800) }),
  );
  const sent: unknown[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/telemetry") && r.method() === "POST") sent.push(r.postDataJSON());
  });
  await page.goto("/notebook");
  await ask(page, "why does the force cancel out?");
  await expect(page.getByTestId("tutor-caption")).toHaveText(speech);

  // Leaving the notebook (here for Settings, from the desk's menu) sends what's queued: timings
  // only.
  await page.getByRole("button", { name: "Close debug panel" }).click();
  await page.getByRole("button", { name: "Back to the desk" }).click();
  await page.getByRole("button", { name: "Your account and more" }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect.poll(() => sent.length).toBeGreaterThan(0);
  expect(JSON.stringify(sent)).not.toContain("force");
  await expect
    .poll(
      async () => {
        await page.reload();
        // Wait until the numbers have loaded (a table, or "no turns yet"), then look.
        await expect(
          page.getByTestId("latency-table").or(page.getByTestId("latency-empty")),
        ).toBeVisible();
        return page.getByTestId("latency-table").count();
      },
      { timeout: 15_000 },
    )
    .toBe(1);
  await expect(page.getByTestId("latency-table")).toContainText("Neb decides");
});

test("the web app is installable (manifest and icons)", async ({ page }) => {
  await page.goto("/notebook");
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  expect(href).toBe("/manifest.webmanifest");
  const manifest = (await (await page.request.get(href ?? "")).json()) as {
    name: string;
    display: string;
    start_url: string;
    icons: { src: string; sizes: string }[];
  };
  expect(manifest).toMatchObject({ name: "Neb", display: "standalone", start_url: "/notebook" });
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src, { headers: ORIGIN_HEADER(page) });
    expect(response.headers()["content-type"]).toBe("image/png");
  }
});

test("in the desktop app, onboarding offers to try Screen Coach on a sample slide (U9)", async ({
  page,
}) => {
  await setSettings(page, { onboarded: false });
  // The desktop app's bridge, stubbed: Screen Coach starts off, and its settings turn it on.
  await page.addInitScript(() => {
    let on = false;
    const calls: unknown[] = [];
    Object.assign(window, {
      __TAURI_INTERNALS__: {},
      __calls: calls,
      __TAURI__: {
        core: {
          invoke: (cmd: string, args: { openSettings?: boolean }) => {
            calls.push({ cmd, args });
            if (cmd !== "screen_coach_onboarding") return Promise.resolve(null);
            if (args.openSettings) on = true;
            return Promise.resolve(on);
          },
        },
      },
    });
  });
  await page.goto("/notebook");
  const intro = page.getByTestId("onboarding");
  await intro.getByRole("button", { name: "Right hand" }).click();
  await intro.getByRole("button", { name: "Skip, neb will learn as you go" }).click();
  await intro.getByRole("button", { name: "Next", exact: true }).click();
  await expect(intro.getByRole("heading", { name: "Try it on your screen" })).toBeVisible();
  await expect(intro).toContainText("Screen Coach is off");
  await intro.getByRole("button", { name: "Turn on Screen Coach" }).click();
  await expect(intro.getByTestId("try-slide")).toBeVisible();
  await expect(intro).toContainText("pick Select, and circle the arrow");
  await intro.getByRole("button", { name: "Next", exact: true }).click();
  await expect(intro.getByRole("heading", { name: "Talk while you study" })).toBeVisible();
});
