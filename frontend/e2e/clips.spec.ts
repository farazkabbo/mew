import { expect, type Page, test } from "./fixtures";

/**
 * Screen Coach S3: a clip saved in the desktop app becomes a notebook page. The desktop app
 * hands the page only the clip's id (`/notebook?clip=…`); the page reads the clip with its own
 * session and builds the page locally. The clip routes are mocked; everything else is real.
 */

const DB_NAME = "mew-notebooks-local";
const CLIP_ID = "55555555-5555-4555-8555-555555555555";
const LINK = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=754";

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

/** A real JPEG, drawn by the browser (the page decodes it with createImageBitmap). */
async function jpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 100;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fdf6e3";
    ctx.fillRect(0, 0, 300, 100);
    ctx.fillStyle = "#1d1c1a";
    ctx.fillRect(20, 40, 200, 10);
    return canvas.toDataURL("image/jpeg").split(",")[1] ?? "";
  });
  return Buffer.from(base64, "base64");
}

async function storedPage(page: Page) {
  return page.evaluate(
    (name) =>
      new Promise<{ images: unknown[]; tutorStrokes: number }>((resolve, reject) => {
        const open = indexedDB.open(name);
        open.onerror = () => reject(new Error("can't open the notebook"));
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(["images", "strokes"], "readonly");
          const images = tx.objectStore("images").getAll();
          const strokes = tx.objectStore("strokes").getAll();
          tx.oncomplete = () =>
            resolve({
              images: images.result as unknown[],
              tutorStrokes: (strokes.result as { author: string }[]).filter(
                (s) => s.author === "tutor",
              ).length,
            });
        };
      }),
    DB_NAME,
  );
}

test("a clip saved from the screen opens as a page with its picture, ink and source", async ({
  page,
}) => {
  await page.goto("about:blank");
  const picture = await jpeg(page);
  let noted: unknown = null;
  await page.route(`**/api/clips/${CLIP_ID}`, (route) => {
    if (route.request().method() === "PATCH") {
      noted = route.request().postDataJSON();
      return route.fulfill({ json: {} });
    }
    return route.fulfill({
      json: {
        id: CLIP_ID,
        width: 300,
        height: 100,
        pixelRatio: 1,
        strokes: [
          {
            tool: "pen",
            color: "#8a7bf0",
            width: 3,
            points: [
              [10, 10, 0.5, 0],
              [120, 30, 0.5, 40],
            ],
          },
        ],
        source: {
          app: "msedge.exe",
          title: "Worksheet 3",
          url: LINK,
          timestampSec: 754,
          capturedAt: "2026-10-22T10:00:00.000Z",
        },
        ocrText: "Question 3. A 2 kg block slides",
        notebookPageId: null,
        createdAt: "2026-10-22T10:00:01.000+00:00",
      },
    });
  });
  let pictureFetched = false;
  await page.route(`**/api/clips/${CLIP_ID}/image`, (route) => {
    pictureFetched = true;
    return route.fulfill({ contentType: "image/jpeg", body: picture });
  });

  await page.goto(`/notebook?clip=${CLIP_ID}`);

  const source = page.getByTestId("clip-source");
  await expect(source).toContainText("Worksheet 3 · 12:34");
  await expect(source.getByRole("link", { name: "Open source" })).toHaveAttribute("href", LINK);
  await expect(source.getByRole("link")).toHaveAttribute("rel", "noopener noreferrer");
  expect(new URL(page.url()).searchParams.has("clip")).toBe(false);
  await expect.poll(() => pictureFetched).toBe(true);
  await expect.poll(() => noted).toMatchObject({ notebookPageId: expect.any(String) });

  const stored = await storedPage(page);
  expect(stored.images).toHaveLength(1);
  expect(stored.images[0]).toMatchObject({
    clipId: CLIP_ID,
    ocrText: "Question 3. A 2 kg block slides",
  });
  expect(stored.tutorStrokes).toBe(1);

  // The picture is drawn under the ink, at its place on the page: the test image's dark bar
  // (image pixels 20–220 × 40–50) is at page (48 + 120, 104 + 45) at the default view.
  await expect
    .poll(() =>
      page.getByTestId("ink-layer").evaluate((canvas: HTMLCanvasElement) => {
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const ctx = canvas.getContext("2d");
        const [r, g, b] = ctx?.getImageData(168 * dpr, 149 * dpr, 1, 1).data ?? [255, 255, 255];
        return (r ?? 255) + (g ?? 255) + (b ?? 255);
      }),
    )
    .toBeLessThan(200);

  // The same clip again (a second event): no second page.
  await page.evaluate(
    (clipId) => window.dispatchEvent(new CustomEvent("mew:open-clip", { detail: { clipId } })),
    CLIP_ID,
  );
  await page.waitForTimeout(500);
  expect((await storedPage(page)).images).toHaveLength(1);
});
