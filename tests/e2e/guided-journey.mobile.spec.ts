import { expect, test } from "@playwright/test";

test("guided journey and Daily V2 remain usable on a narrow screen", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByRole("heading", { name: "Build your Sokoban instincts" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Seven-day daily challenge history" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Play suggestion" })).toBeVisible();

  const overflows = await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth);
  expect(overflows).toBe(false);

  await page.getByRole("button", { name: "Pause guided path" }).click();
  await expect(page.getByRole("button", { name: "Resume guided path" })).toBeVisible();
});
