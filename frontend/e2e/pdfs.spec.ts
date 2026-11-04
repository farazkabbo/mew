import { expect, type Page, test } from "./fixtures";
import { makePdf } from "./helpers/pdf";

/**
 * PDFs into notebooks and chapters (K4, docs/NOTEBOOKS_K.md §14): a PDF dropped into a notebook
 * without a course is split into chapters by its outline, its pages drawn under the ink (and kept
 * on the device), and it becomes course material for a new course, with "Review topics" later.
 * The API service is real here (pdfium in its sandbox, local mode).
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const BOOK = makePdf(
  [
    ["Contents", "1 Atoms", "2 Bonding"],
    ["Chapter 1 Atoms", "An atom has a nucleus of protons and neutrons."],
    ["Electrons fill shells around the nucleus.", "The outer shell decides how it bonds."],
    ["Chapter 2 Bonding", "Ionic bonds transfer electrons between atoms."],
    ["Covalent bonds share electrons between atoms."],
  ],
  [
    ["Chapter 1 Atoms", 1],
    ["Chapter 2 Bonding", 3],
  ],
);

async function newNotebook(page: Page, name: string) {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  await page.keyboard.press("Alt+KeyB");
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Name").press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("treeitem", { name })).toHaveAttribute("aria-current", "page");
}

/** How many PDF pages this device keeps (IndexedDB, the notebook's own database). */
function cachedPages(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const names = (await indexedDB.databases()).map((d) => d.name ?? "");
    const name = names.find((n) => n.startsWith("mew-notebooks-"));
    if (!name) return 0;
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("open failed"));
    });
    const count = await new Promise<number>((resolve, reject) => {
      const request = db.transaction("pdfPages").objectStore("pdfPages").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("count failed"));
    });
    db.close();
    return count;
  });
}

test("a PDF is split into chapters, drawn under the ink, kept offline, and becomes a course", async ({
  page,
}) => {
  const name = `Chemistry ${Math.random().toString(36).slice(2, 6)}`;
  await newNotebook(page, name);

  await page.keyboard.press("Control+KeyO");
  const dialog = page.getByRole("dialog", { name: "Import a PDF" });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "chemistry.pdf",
    mimeType: "application/pdf",
    buffer: BOOK,
  });
  await expect(dialog.getByText("chemistry.pdf · 5 pages")).toBeVisible();
  // The outline proposes the chapters, with which pages go where.
  await expect(dialog.getByRole("checkbox", { name: /Split into chapters/ })).toBeChecked();
  const chapters = dialog.getByRole("list", { name: "Chapters" });
  await expect(chapters.getByText("pp. 2–3")).toBeVisible();
  await expect(chapters.getByText("pp. 4–5")).toBeVisible();
  await dialog.getByLabel("Chapter name for Chapter 2 Bonding").fill("Bonding");
  // No course yet: one is made for it (decision 8).
  await expect(dialog.getByText(`Use as course material (creates a ${name} course)`)).toBeVisible();

  const drawn = page.waitForResponse(
    (r) => /\/api\/pdfs\/[^/]+\/pages\/1\/image$/.test(r.url()) && r.status() === 200,
  );
  await dialog.getByRole("button", { name: "Import" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(/Imported 5 pages into 2 chapters/)).toBeVisible();

  // The chapters are in the tree; the first page of the first chapter opened with the PDF page.
  await expect(page.getByRole("treeitem", { name: "Chapter 1 Atoms" })).toBeVisible();
  await expect(page.getByRole("treeitem", { name: "Bonding" })).toBeVisible();
  const response = await drawn;
  expect(response.headers()["content-type"]).toBe("image/png");
  await expect.poll(() => cachedPages(page)).toBeGreaterThan(0);

  // The notebook has course material now (decision U26): a Study tab, and "Review topics" once its
  // topics are found, which opens it.
  await page.getByRole("treeitem", { name }).click();
  await expect(page.getByTestId("node-home")).toBeVisible();
  await expect(page.getByTestId("add-material")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Study" })).toBeVisible();
  const reviewTopics = page.getByRole("button", { name: "Review topics" });
  await expect(reviewTopics).toBeVisible({ timeout: 30_000 });
  await reviewTopics.click();
  await expect(page.getByRole("tab", { name: "Study" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("course-study")).toContainText("Needs review");
});

test("refuses a password-protected PDF with a clear message", async ({ page }) => {
  await newNotebook(page, `Locked ${Math.random().toString(36).slice(2, 6)}`);
  const locked = Buffer.from(
    BOOK.toString("latin1").replace(
      "/Root 1 0 R >>",
      "/Root 1 0 R /Encrypt << /Filter /Standard /V 2 /R 3 /O <00> /U <00> /P -4 >> /ID [<00> <00>] >>",
    ),
    "latin1",
  );
  await page.keyboard.press("Control+KeyO");
  const dialog = page.getByRole("dialog", { name: "Import a PDF" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "locked.pdf",
    mimeType: "application/pdf",
    buffer: locked,
  });
  await expect(dialog.getByRole("alert")).toContainText("password-protected");
});
