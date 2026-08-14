import { expect, test, type Locator, type Page } from "@playwright/test";

async function expectInsideViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (!bounds || !viewport) return;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
}

test("home experience controls remain clickable at 320 pixels", async ({
  page,
}) => {
  await page.goto("./");

  const settingsTrigger = page.getByRole("button", {
    name: "Sound and motion settings",
  });
  await expectInsideViewport(page, settingsTrigger);
  await settingsTrigger.click();
  await expect(
    page.getByRole("dialog", { name: "Sound & motion" }),
  ).toBeVisible();
});

test("all play actions and mobile movement guidance remain reachable", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");

  for (const name of [
    /all audio/,
    "Sound and motion settings",
    "Add to favorites",
    "Open progress",
    "Open solver laboratory",
    "Share this puzzle and route",
    "How to play",
  ]) {
    await expectInsideViewport(page, page.getByRole("button", { name }));
  }

  await expect(
    page.getByText("Swipe the board to move, or use the controls below."),
  ).toBeVisible();
  await page.getByRole("button", { name: "How to play" }).click();
  await expect(page.getByRole("dialog", { name: "How to play" })).toBeVisible();

  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
});

test("mobile navigation exposes real links", async ({ page }) => {
  await page.goto("./#/puzzles");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  await expect(navigation.getByRole("link", { name: "Home" })).toHaveAttribute(
    "href",
    "#/",
  );
  await expect(
    navigation.getByRole("link", { name: "Puzzles" }),
  ).toHaveAttribute("aria-current", "page");
});

test("offline status is explicit and clears when connectivity returns", async ({
  page,
}) => {
  await page.goto("./");
  await page.context().setOffline(true);
  await expect(
    page.getByRole("status").filter({ hasText: "You're offline" }),
  ).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.getByText("You're offline.")).toHaveCount(0);
});

test("editor offers a guided starter and keeps tools sticky at 320 pixels", async ({
  page,
}) => {
  await page.goto("./#/editor");

  await expect(
    page.getByRole("heading", { name: "Start with a working room" }),
  ).toBeVisible();
  const tools = page.getByRole("region", { name: "Editor tools" });
  await expect(tools).toBeVisible();
  expect(
    await tools.evaluate((node) =>
      getComputedStyle(node.parentElement!.parentElement!).position
    ),
  ).toBe("sticky");

  await page.getByRole("button", { name: "Single push starter" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("Single push starter");
  await expect(page.getByRole("button", { name: "Test puzzle" })).toBeEnabled();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
});
