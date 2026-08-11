import { expect, test } from "@playwright/test";

test("stats import enforces bounds and reports unchanged and rejected records", async ({
  page,
}) => {
  const same = {
    moves: 5,
    pushes: 1,
    completedAt: "2026-08-11T12:00:00.000Z",
  };
  await page.addInitScript(({ first }) => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      generation: 1,
      revision: 1,
      writerId: "stats-import-test",
      completed: {
        "ultra-tiny": first,
        "first-steps": {
          moves: 6,
          pushes: 1,
          completedAt: "2026-08-11T12:01:00.000Z",
        },
      },
      daily: {},
    }));
  }, { first: same });
  await page.goto("./#/stats");

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "progress.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      version: 2,
      completed: {
        "ultra-tiny": same,
        "first-steps": {
          moves: 7,
          pushes: 1,
          completedAt: "2026-08-11T12:02:00.000Z",
        },
        "not-in-the-catalog": {
          moves: 1,
          pushes: 0,
          completedAt: "2026-08-11T12:03:00.000Z",
        },
      },
      daily: {},
    })),
  });
  await expect(page.getByRole("status").filter({ hasText: "No changes:" }))
    .toContainText("0 added, 0 improved, 1 unchanged, 2 rejected, 0 invalid");

  await input.setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.from("x".repeat(1_000_001)),
  });
  await expect(page.getByRole("status").filter({ hasText: "too large" }))
    .toBeVisible();
});
