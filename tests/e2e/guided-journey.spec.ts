import { expect, test } from "@playwright/test";

test("guided path explains a deterministic suggestion and keeps catalog open", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      completed: {
        "ultra-tiny": {
          moves: 3,
          pushes: 1,
          completedAt: "2026-08-28T12:00:00.000Z",
        },
      },
      daily: {},
      activity: { "2026-08-28": ["ultra-tiny"] },
    }));
  });
  await page.goto("./");

  const recommendation = page.getByTestId("journey-recommendation");
  await expect(recommendation).toContainText("One Push Wonder");
  await expect(recommendation).toContainText("next unsolved room");
  await expect(page.getByRole("list", { name: "Guided journey chapters" })).toBeVisible();

  await page.getByRole("button", { name: /Browse all \d+ puzzles/ }).click();
  await expect(page).toHaveURL(/#\/puzzles$/);
  await expect(page.getByRole("heading", { name: "Choose a difficulty" })).toBeVisible();
});

test("players can pause and resume the guided path across reloads", async ({ page }) => {
  await page.goto("./");
  await page.getByRole("button", { name: "Pause guided path" }).click();

  await expect(page.getByRole("heading", { name: "Explore your own way" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem("sokomind.guided-journey.v1")))
    .toContain('"dismissed":true');

  await page.reload();
  await expect(page.getByRole("button", { name: "Resume guided path" })).toBeVisible();
  await page.getByRole("button", { name: "Resume guided path" }).click();
  await expect(page.getByRole("heading", { name: "Build your Sokoban instincts" })).toBeVisible();
});

test("daily V2 presents today, a seven-day history, and a playable room", async ({ page }) => {
  await page.goto("./");

  await expect(page.getByRole("heading", { name: /Daily room unavailable/ })).toHaveCount(0);
  const history = page.getByRole("list", { name: "Seven-day daily challenge history" });
  await expect(history).toBeVisible();
  await expect(history.getByRole("listitem")).toHaveCount(7);
  await expect(history).toContainText("Today");

  await page.getByRole("button", { name: "Play today" }).click();
  await expect(page).toHaveURL(/#\/play\//);
});
