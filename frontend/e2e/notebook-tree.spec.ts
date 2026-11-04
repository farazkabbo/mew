import { expect, type Page, test } from "./fixtures";

/**
 * The notebook tree (K1, docs/NOTEBOOKS_K.md §14): naming a notebook as it's made, chapters,
 * the home view, the sidebar tree, the jump palette, the trash, and keeping all of it on the
 * device (synced to the account when there's a connection).
 */

test.beforeEach(({ page }) => {
  page.on("console", (message) => {
    if (/Content.Security.Policy|Refused to/i.test(message.text())) {
      throw new Error(`CSP violation: ${message.text()}`);
    }
  });
});

const unique = () => Math.random().toString(36).slice(2, 7);

async function openNotebook(page: Page) {
  await page.goto("/notebook");
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
}

/** The server's copy of the tree (the API service's local store in these tests). */
async function serverTitles(page: Page): Promise<string[]> {
  const response = await page.request.get("/api/notebooks/tree");
  const { nodes } = (await response.json()) as { nodes: { title: string }[] };
  return nodes.map((n) => n.title);
}

/** The home view shows these chapter cards, in this order (waits for them). */
async function expectCards(page: Page, titles: string[]) {
  await expect(page.getByTestId("chapter-card").locator("span.font-serif")).toHaveText(titles);
}

test("a notebook is named as it's made, with its chapters, and stays after a reload", async ({
  page,
}) => {
  const name = `Physics ${unique()}`;
  await openNotebook(page);

  // Alt+B: the name field is ready, with its placeholder selected so typing replaces it.
  await page.keyboard.press("Alt+b");
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel("Name");
  await expect(field).toBeFocused();
  await expect(field).toHaveValue("Untitled notebook");
  expect(
    await field.evaluate(
      (el: HTMLInputElement) => (el.selectionEnd ?? 0) - (el.selectionStart ?? 0),
    ),
  ).toBe("Untitled notebook".length);
  await page.keyboard.type(name);

  // The sidebar shows the notebook being made; its icon follows the name.
  await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Atom" })).toHaveAttribute("aria-checked", "true");

  // 4 chapters, the second renamed before creating; Enter (from that field) creates it.
  await dialog.getByLabel("Number of chapters").fill("4");
  const second = dialog.getByLabel("Chapter 2 name");
  await second.fill("Forces");
  await second.press("Enter");

  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("node-home")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  await expectCards(page, ["Chapter 1", "Forces", "Chapter 3", "Chapter 4"]);
  await expect(page.getByRole("treeitem", { name })).toHaveAttribute("aria-current", "page");

  // It reached the account…
  await expect.poll(() => serverTitles(page)).toEqual(expect.arrayContaining([name, "Forces"]));

  // …and after a reload it's all there, from this device, even with the server unreachable.
  await page.route("**/api/notebooks/tree", (route) => route.abort());
  await page.reload();
  await expect(page.getByTestId("node-home")).toBeVisible();
  await expectCards(page, ["Chapter 1", "Forces", "Chapter 3", "Chapter 4"]);
});

test("a chapter opens on its page with a breadcrumb; Alt+N adds one ready to name", async ({
  page,
}) => {
  const name = `Chemistry ${unique()}`;
  await openNotebook(page);
  await page.keyboard.press("Alt+b");
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Number of chapters").fill("2");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByTestId("node-home")).toBeVisible();

  // Alt+N: a new chapter, opened, with its name field ready in the sidebar.
  await page.keyboard.press("Alt+n");
  const rename = page.getByRole("tree").getByLabel("Name");
  await expect(rename).toBeFocused();
  await page.keyboard.type("Acids and bases");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: "Acids and bases" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("notebook-canvas")).toBeVisible();
  const crumbs = page.getByTestId("breadcrumb");
  await expect(crumbs).toContainText(name);
  await expect(crumbs).toContainText("Acids and bases");
  await expect(crumbs).toContainText("Page 1");

  // The breadcrumb's notebook opens the home, now with three chapters.
  await crumbs.getByRole("button", { name }).click();
  await expectCards(page, ["Chapter 1", "Chapter 2", "Acids and bases"]);
});

test("a notebook opens on its home, and loose pages go into chapters by picker or by drag", async ({
  page,
}) => {
  const name = `Biology ${unique()}`;
  await openNotebook(page);
  await page.keyboard.press("Alt+b");
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Number of chapters").fill("2");
  await dialog.getByRole("button", { name: "Create" }).click();
  const home = page.getByTestId("node-home");
  await expect(home).toBeVisible();

  // Two loose pages on the notebook itself.
  for (let i = 0; i < 2; i++) {
    await home.getByRole("button", { name: "New page" }).click();
    await expect(page.getByTestId("notebook-canvas")).toBeVisible();
    // Clicking the notebook in the sidebar opens its home, not a page.
    await page.getByRole("treeitem", { name }).click();
    await expect(home).toBeVisible();
  }
  const loose = home.getByTestId("loose-page");
  await expect(loose).toHaveCount(2);
  await expect(home).toContainText("Drag a page onto a chapter to put it there");

  // The move button: the picker, then Chapter 1.
  await loose
    .first()
    .getByRole("button", { name: /^Move page \d+ to…$/ })
    .click();
  const picker = page.getByRole("dialog", { name: "Move this page to…" });
  await picker.getByRole("button", { name: "Chapter 1", exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(loose).toHaveCount(1);
  const cards = home.getByTestId("chapter-card");
  // (each chapter starts with a page of its own)
  await expect(cards.nth(0)).toContainText("2 pages");

  // Dragged onto Chapter 2's card.
  await loose.first().getByRole("button").first().dragTo(cards.nth(1));
  await expect(loose).toHaveCount(0);
  await expect(cards.nth(1)).toContainText("2 pages");
});

test("rename, jump, delete with undo, and the trash", async ({ page }) => {
  const name = `Biology ${unique()}`;
  await openNotebook(page);
  await page.keyboard.press("Alt+b");
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Add a chapter").fill("Cells");
  await dialog.getByLabel("Add a chapter").press("Enter");
  await dialog.getByLabel("Add a chapter").fill("Genetics");
  await dialog.getByLabel("Add a chapter").press("Enter");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expectCards(page, ["Cells", "Genetics"]);

  // F2 renames the open node; a sibling's name is refused with a suggestion.
  await page.getByRole("treeitem", { name: "Cells" }).click();
  await page.keyboard.press("F2");
  const field = page.getByRole("tree").getByLabel("Name");
  await field.fill("Genetics");
  await field.press("Enter");
  await expect(page.getByRole("tree").getByRole("alert")).toContainText("Try “Genetics 2”");
  await field.fill("Cell biology");
  await field.press("Enter");
  await expect(page.getByRole("treeitem", { name: "Cell biology" })).toBeVisible();

  // Ctrl+K finds a chapter by part of its name.
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog", { name: "Jump to" });
  await palette.getByRole("combobox").fill("genet");
  await expect(palette.getByRole("option").first()).toContainText("Genetics");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("treeitem", { name: "Genetics" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // Deleting the notebook asks first (it has chapters), then offers Undo.
  const row = page.getByRole("treeitem", { name });
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("dialog", { name: new RegExp(`Delete notebook “${name}”`) });
  await expect(confirm).toContainText("2 chapters");
  await confirm.getByRole("button", { name: "Move to trash" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(row).toBeVisible();

  // In the trash and back.
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Move to trash" }).click();
  await page.getByRole("button", { name: /^Trash/ }).click();
  const trash = page.getByRole("dialog", { name: "Trash" });
  await expect(trash).toContainText(name);
  await trash.getByRole("button", { name: "Restore" }).first().click();
  await trash.getByRole("button", { name: "Close" }).click();
  await expect(row).toBeVisible();
});

test("the tree works offline and syncs when the connection comes back", async ({
  page,
  context,
}) => {
  const name = `Offline ${unique()}`;
  await openNotebook(page);
  await context.setOffline(true);
  await page.keyboard.press("Alt+b");
  const dialog = page.getByRole("dialog", { name: "New notebook" });
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("treeitem", { name })).toBeVisible();
  await context.setOffline(false);
  await expect.poll(() => serverTitles(page), { timeout: 15_000 }).toContain(name);
});
