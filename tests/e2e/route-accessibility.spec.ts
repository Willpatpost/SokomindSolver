import { expect, test } from "@playwright/test";

test("puzzle route changes announce and focus the new heading", async ({ page }) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "#/play/tiny";
  });

  const secondHeading = page.getByRole("heading", { name: "Two's Company" });
  await expect(secondHeading).toBeVisible();
  await expect(secondHeading).toBeFocused();
  await expect(page.locator('.sr-only[role="status"]').first()).toHaveText(
    "Navigated to Two's Company",
  );

  await page.goBack();
  const firstHeading = page.getByRole("heading", { name: "First Steps" });
  await expect(firstHeading).toBeVisible();
  await expect(firstHeading).toBeFocused();
  await expect(page.locator('.sr-only[role="status"]').first()).toHaveText(
    "Navigated to First Steps",
  );
});

test("a cold lazy route change waits for the new visible heading", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();

  await page.evaluate(() => {
    window.location.hash = "";
  });
  const homeHeading = page.getByRole("heading", { name: "Sokomind" });
  await expect(homeHeading).toBeVisible();
  await expect(homeHeading).toBeFocused();
  await expect(page.getByRole("status")).toHaveText("Navigated to Sokomind");
});

test("history cannot attach an old timer to a fresh puzzle attempt", async ({
  page,
}) => {
  await page.goto("./#/play/tutorial-push");
  await page.getByRole("button", { name: "Move left" }).click();
  await expect(page.getByTestId("moves-count")).toHaveText("1");
  await page.waitForTimeout(1_100);
  await expect(page.getByTestId("elapsed-time")).toHaveText("0:01");

  await page.evaluate(() => {
    window.location.hash = "#/play/ultra-tiny";
  });
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.goBack();

  await expect(
    page.getByRole("heading", { name: "One Push Wonder" }),
  ).toBeVisible();
  await expect(page.getByTestId("moves-count")).toHaveText("0");
  await expect(page.getByTestId("elapsed-time")).toHaveCount(0);
  expect(await page.evaluate(() =>
    Number(sessionStorage.getItem("sokomind:timer:tutorial-push") ?? "0")))
    .toBe(0);
});
