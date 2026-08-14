import { expect, test } from "@playwright/test";

test("a failed puzzle shard has a local retry path", async ({ page }) => {
  let attempts = 0;
  await page.route(/puzzle-shard-\d+.*\.json$/u, async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.abort("internetdisconnected");
      return;
    }
    await route.continue();
  });

  await page.goto("./#/play/ultra-tiny");
  const failure = page.getByRole("alert");
  await expect(
    failure.getByRole("heading", { name: "Couldn't load this puzzle" }),
  ).toBeVisible();
  await failure.getByRole("button", { name: "Retry loading" }).click();
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  expect(attempts).toBe(2);
});
