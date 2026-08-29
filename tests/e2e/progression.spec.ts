import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ACHIEVEMENTS } from "../../src/features/achievements/achievements";
import { PUZZLE_METADATA } from "../../src/catalog/puzzle-metadata";

const solvedIds = PUZZLE_METADATA.slice(0, 10).map(({ id }) => id);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((puzzleIds) => {
    const completed = Object.fromEntries(puzzleIds.map((puzzleId, index) => [
      puzzleId,
      {
        moves: 4,
        pushes: 1,
        completedAt: `2026-08-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      },
    ]));
    const activity = Object.fromEntries(puzzleIds.map((puzzleId, index) => [
      `2026-08-${String(index + 1).padStart(2, "0")}`,
      [puzzleId],
    ]));
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      generation: 0,
      revision: 1,
      writerId: "progression-test",
      completed,
      daily: {},
      activity,
    }));
  }, solvedIds);
});

test("progression groups transparent achievements and recent milestones", async ({ page }) => {
  await page.goto("./#/stats");

  await expect(page.getByRole("heading", { name: "Achievements and keepsakes" })).toBeVisible();
  for (const collection of ["Room by room", "Steady practice", "Catalog mastery", "Route craft"]) {
    await expect(page.getByRole("heading", { name: collection })).toBeVisible();
  }
  await expect(page.getByRole("progressbar", { name: /Getting Started/ }))
    .toHaveAttribute("aria-valuenow", "10");
  await expect(page.getByRole("progressbar")).toHaveCount(ACHIEVEMENTS.length);
  await expect(page.getByRole("heading", { name: "The path behind you" })).toBeVisible();
  await expect(page.getByText("Based on saved completion dates")).toBeVisible();
  await expect(page.getByText("Every requirement is visible")).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include("main")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("earned board frames persist while locked keepsakes stay unavailable", async ({ page }) => {
  await page.goto("./#/stats");

  const sage = page.getByRole("button", { name: /Sage thread/ });
  const brass = page.getByRole("button", { name: /Brass edge/ });
  await expect(sage).toBeEnabled();
  await expect(brass).toBeDisabled();
  const classicBorder = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--game-board-border").trim());
  await sage.click();
  await expect(sage).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-board-frame", "sage-thread");
  await expect.poll(() => page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--game-board-border").trim()))
    .toBe("#708872c7");
  expect(classicBorder).not.toBe("#708872c7");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-board-frame", "sage-thread");
  await expect(page.getByRole("button", { name: /Sage thread/ })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sokomind.cosmetics.v1")))
    .toContain('"boardFrame":"sage-thread"');
});
