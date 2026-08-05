import { expect, test } from "@playwright/test";

const COMPLETED_AT = "2026-08-01T00:00:00.000Z";

test("unknown progress records never inflate the home completion total", async ({
  page,
}) => {
  await page.addInitScript((completedAt) => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 1,
      completed: {
        "ultra-tiny": { moves: 8, pushes: 1, completedAt },
        "retired-room-1": { moves: 1, pushes: 1, completedAt },
        "retired-room-2": { moves: 1, pushes: 1, completedAt },
      },
    }));
  }, COMPLETED_AT);

  await page.goto("./");

  await expect(page.getByText(/^1 of \d+ rooms cleared$/)).toBeVisible();
  const progressbar = page.getByRole("progressbar", {
    name: "Puzzle completion progress",
  });
  const value = Number(await progressbar.getAttribute("aria-valuenow"));
  expect(value).toBeGreaterThanOrEqual(0);
  expect(value).toBeLessThanOrEqual(100);
});

test("Continue opens the first unsolved puzzle when no session is saved", async ({
  page,
}) => {
  await page.addInitScript((completedAt) => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 1,
      completed: {
        "ultra-tiny": { moves: 8, pushes: 1, completedAt },
      },
    }));
  }, COMPLETED_AT);

  await page.goto("./");
  await page.getByRole("button", { name: "Continue playing" }).click();

  await expect(page).toHaveURL(/#\/play\/tiny$/);
  await expect(page.getByRole("heading", { name: "Two's Company" })).toBeVisible();
});

test("Continue prefers a saved session over the first unsolved puzzle", async ({
  page,
}) => {
  await page.addInitScript((completedAt) => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 1,
      completed: {
        "ultra-tiny": { moves: 8, pushes: 1, completedAt },
      },
    }));
    localStorage.setItem("sokomind.session.v1", JSON.stringify({
      version: 1,
      puzzleId: "tutorial-push",
      actionLog: "",
      updatedAt: completedAt,
    }));
  }, COMPLETED_AT);

  await page.goto("./");
  await page.getByRole("button", { name: "Continue playing" }).click();

  await expect(page).toHaveURL(/#\/play\/tutorial-push$/);
  await expect(page.getByRole("heading", { name: "One Push Wonder" })).toBeVisible();
});
