import { expect, test } from "@playwright/test";

test("progression collections and cosmetics remain contained on mobile", async ({ page }) => {
  await page.goto("./#/stats");

  await expect(page.getByRole("heading", { name: "Achievements and keepsakes" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a quiet finishing touch" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Classic frame/ })).toBeVisible();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
});
