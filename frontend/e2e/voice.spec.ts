import { expect, type Page, test } from "./fixtures";

// A fake microphone (a test tone) with permission pre-granted.
test.use({
  launchOptions: {
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  },
  permissions: ["microphone"],
});

const SESSION = {
  token: "sutkn_test",
  modelId: "scribe_v2_realtime",
  url: "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
};

type GateCall = { trigger: string; lastUtterance: string; explicitSummon: boolean };

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

/** Fakes the gate: questions get answered, everything else is ignored. Records every call. */
async function fakeGate(page: Page): Promise<GateCall[]> {
  const calls: GateCall[] = [];
  await page.route("**/api/mew", async (route) => {
    const body = route.request().postDataJSON() as GateCall;
    calls.push(body);
    const question = /\?$/.test(body.lastUtterance) || body.explicitSummon;
    await route.fulfill({
      json: {
        output: question
          ? { label: "answer_question", confidence: 0.93, reason: "direct question" }
          : { label: "ignore", confidence: 0.9, reason: "reading aloud" },
        source: "model",
        latencyMs: 180,
      },
    });
  });
  return calls;
}

async function openNotebook(page: Page) {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
}

test("streams the microphone to speech-to-text and sends each finished utterance to Mew", async ({
  page,
}) => {
  const gateCalls = await fakeGate(page);
  await page.route("**/api/stt/token", (route) => route.fulfill({ json: SESSION }));

  let socketUrl: URL | null = null;
  const audioChunks: { message_type: string; audio_base_64: string; sample_rate: number }[] = [];
  await page.routeWebSocket(/api\.elevenlabs\.io/, (ws) => {
    socketUrl = new URL(ws.url());
    let replied = false;
    ws.onMessage((raw) => {
      audioChunks.push(JSON.parse(String(raw)) as (typeof audioChunks)[number]);
      if (replied || audioChunks.length < 3) return;
      replied = true;
      const send = (m: object) => ws.send(JSON.stringify(m));
      send({ message_type: "session_started", session_id: "s1", config: {} });
      send({ message_type: "partial_transcript", text: "okay so I'm" });
      send({ message_type: "committed_transcript", text: "okay so I'm reading this" });
      send({ message_type: "partial_transcript", text: "why does the" });
      send({ message_type: "committed_transcript", text: "why does the force cancel out?" });
    });
  });

  await openNotebook(page);
  await page.getByRole("button", { name: "Debug panel" }).click();
  await page.getByRole("button", { name: "Start listening" }).click();

  await expect(page.getByTestId("voice-status")).toHaveText("listening");
  await expect(page.getByTestId("transcript")).toContainText("why does the force cancel out?");
  await expect.poll(() => gateCalls.length).toBe(2);

  // Socket opened with a single-use token and the documented parameters.
  const params = (socketUrl as URL | null)?.searchParams;
  expect(params?.get("token")).toBe("sutkn_test");
  expect(params?.get("model_id")).toBe("scribe_v2_realtime");
  expect(params?.get("audio_format")).toBe("pcm_16000");
  expect(params?.get("commit_strategy")).toBe("vad");
  expect(params?.get("vad_silence_threshold_secs")).toBe("0.7");

  // Audio arrives as 100 ms chunks of 16 kHz 16-bit PCM.
  const chunk = audioChunks[0];
  expect(chunk?.message_type).toBe("input_audio_chunk");
  expect(chunk?.sample_rate).toBe(16000);
  expect(Buffer.from(chunk?.audio_base_64 ?? "", "base64").byteLength).toBe(3200);

  // Reading aloud is ignored; the question is acted on — shown in the debug panel.
  expect(gateCalls.map((c) => c.lastUtterance)).toEqual([
    "okay so I'm reading this",
    "why does the force cancel out?",
  ]);
  const decisions = page.getByTestId("decisions").locator("li");
  await expect(decisions.nth(0)).toHaveAttribute("data-label", "answer_question");
  await expect(decisions.nth(1)).toHaveAttribute("data-label", "ignore");
  await expect(page.locator("[data-mascot-state]")).toHaveAttribute(
    "data-mascot-state",
    "listening",
  );

  await page.getByRole("button", { name: "Stop listening" }).click();
  await expect(page.getByTestId("voice-status")).toHaveText("muted");
});

test('"Hey Mew" in speech is a summon', async ({ page }) => {
  const gateCalls = await fakeGate(page);
  await page.route("**/api/stt/token", (route) => route.fulfill({ json: SESSION }));
  await page.routeWebSocket(/api\.elevenlabs\.io/, (ws) => {
    let sent = false;
    ws.onMessage(() => {
      if (sent) return;
      sent = true;
      ws.send(
        JSON.stringify({ message_type: "committed_transcript", text: "hey mew what's next" }),
      );
    });
  });

  await openNotebook(page);
  await page.getByRole("button", { name: "Start listening" }).click();

  await expect
    .poll(() => gateCalls[0])
    .toMatchObject({
      trigger: "summon",
      explicitSummon: true,
      lastUtterance: "what's next",
    });
});

test("tapping the mascot summons Mew", async ({ page }) => {
  const gateCalls = await fakeGate(page);
  await openNotebook(page);

  await page.getByRole("button", { name: /^Ask Neb/ }).click();

  await expect.poll(() => gateCalls[0]).toMatchObject({ trigger: "summon", explicitSummon: true });
});

test("a pause after writing a few strokes asks Mew whether to check the work", async ({ page }) => {
  const gateCalls = await fakeGate(page);
  await openNotebook(page);
  const box = await page.getByTestId("notebook-canvas").boundingBox();
  if (!box) throw new Error("canvas not visible");

  for (const x of [200, 260, 320]) {
    await page.mouse.move(box.x + x, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + x + 40, box.y + 220, { steps: 5 });
    await page.mouse.up();
  }

  await expect.poll(() => gateCalls[0], { timeout: 5000 }).toMatchObject({ trigger: "pen_pause" });
});

test("explains clearly when speech-to-text isn't configured", async ({ page }) => {
  await page.route("**/api/stt/token", (route) =>
    route.fulfill({ status: 503, json: { error: "This feature is not configured" } }),
  );
  await openNotebook(page);

  await page.getByRole("button", { name: "Start listening" }).click();

  // (Next.js renders its own, empty route-announcer alert, so match by text.)
  await expect(
    page.getByRole("alert").filter({ hasText: "Speech-to-text isn't configured" }),
  ).toBeVisible();
  await expect(page.locator("[data-mascot-state]")).toHaveAttribute("data-mascot-state", "muted");
});

test("the real gate route decides filler by rule and degrades safely without a model key", async ({
  page,
}) => {
  await openNotebook(page);
  await page.getByRole("button", { name: "Debug panel" }).click();
  const input = page.getByRole("textbox", { name: "Simulated utterance" });

  await input.fill("hmm okay");
  await input.press("Enter");
  await input.fill("why does the force cancel out?");
  await input.press("Enter");

  const decisions = page.getByTestId("decisions").locator("li");
  await expect(decisions).toHaveCount(2);
  await expect(decisions.nth(1)).toContainText("rule");
  // With GEMINI_API_KEY set this is classified by the model; without it, Mew stays silent.
  await expect(decisions.nth(0)).toContainText(/model|fallback/);
});
