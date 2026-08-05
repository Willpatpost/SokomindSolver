import { expect, test, type Locator, type Page } from "@playwright/test";

async function visibleBounds(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Visible element has no layout bounds.");
  return bounds;
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const bounds = await visibleBounds(locator);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The visual test requires a viewport.");
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

test("critical Play surfaces retain visible geometry in light and dark themes", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  const board = page.getByTestId("game-board");
  const boardBounds = await visibleBounds(board);
  expect(boardBounds.width).toBeGreaterThan(120);
  expect(boardBounds.height).toBeGreaterThan(120);

  const lightSurface = await page.locator("body").evaluate((element) =>
    getComputedStyle(element).backgroundImage);
  await page.getByRole("button", { name: "Sound and motion settings" }).click();
  const settings = page.getByRole("dialog", { name: "Sound & motion" });
  await settings.getByRole("combobox", { name: /theme/i }).selectOption("dark");
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkSurface = await page.locator("body").evaluate((element) =>
    getComputedStyle(element).backgroundImage);
  expect(darkSurface).not.toBe(lightSurface);
  await expectInsideViewport(page, board);

  await page.keyboard.press("ArrowDown");
  await expectInsideViewport(
    page,
    page.getByRole("dialog", { name: "First Steps" }),
  );
});

test("solver and editor workspaces stay within their reviewed layout bounds", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await page.getByRole("button", { name: "Open solver laboratory" }).click();
  await expectInsideViewport(page, page.getByRole("dialog", { name: "Find a route" }));

  await page.goto("./#/editor");
  const grid = page.getByTestId("editor-grid");
  const bounds = await visibleBounds(grid);
  expect(bounds.width).toBeGreaterThan(200);
  expect(bounds.height).toBeGreaterThan(200);
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow.horizontal).toBe(false);
});
