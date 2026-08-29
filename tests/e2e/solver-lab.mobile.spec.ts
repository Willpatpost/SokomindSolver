import { expect, test } from "@playwright/test";

test("Solver Lab remains operable without horizontal overflow at 320 pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto("./#/solver-lab/ultra-tiny");
  await expect(page.getByRole("heading", { name: "Solver Lab" })).toBeVisible();

  await expect(page.getByLabel("Algorithm")).toBeVisible();
  await expect(page.getByRole("button", { name: "Run search" })).toBeVisible();
  await expect(page.getByTestId("solver-lab-board")).toBeVisible();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);

  await page.getByLabel("Algorithm").selectOption("classic-astar");
  await page.getByRole("button", { name: "Run search" }).click();
  await expect(page.getByLabel("Solution playback position")).toBeVisible();
  await page.getByRole("button", { name: "Step forward" }).click();
  await expect(page.getByText("Move 1 of 1 · 1 pushes in this route", { exact: true })).toBeVisible();
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
});
