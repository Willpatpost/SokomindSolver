import { expect, test } from "@playwright/test";

test("homepage shows branding and all CTAs work", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  await expect(page).toHaveTitle("Sokomind");
  await expect(page.getByText("Think before you push")).toBeVisible();
  await expect(page.getByRole("button", { name: /playing/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Browse puzzles" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create a puzzle" })).toBeVisible();
});

test("difficulty random actions have unique accessible names", async ({ page }) => {
  await page.goto("./#/puzzles");

  for (const difficulty of [
    "Tutorial",
    "Beginner",
    "Intermediate",
    "Advanced",
    "Expert",
    "Master",
  ]) {
    await expect(page.getByRole("button", {
      name: `Random unsolved ${difficulty} puzzle`,
    })).toBeVisible();
  }
});

test("drill-down from home to puzzles to play", async ({ page }) => {
  await page.goto("./");

  await page.getByRole("button", { name: "Browse puzzles" }).click();
  await expect(page.getByRole("heading", { name: "Choose a difficulty" })).toBeVisible();

  await page.getByText("Tutorial").click();
  await expect(page).toHaveURL(/#\/puzzles\/tutorial$/);
  await expect(page.getByRole("heading", { name: "Tutorial" })).toBeVisible();
  await expect(page.getByText("First Steps")).toBeVisible();

  await page.getByText("First Steps").click();
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
});

test("single-collection Tutorial keeps a usable difficulty back link", async ({
  page,
}) => {
  await page.goto("./#/puzzles/tutorial");

  await expect(page).toHaveURL(/#\/puzzles\/tutorial$/);
  await expect(page.getByRole("heading", { name: "Tutorial" })).toBeVisible();
  const breadcrumb = page.getByRole("navigation");
  await expect(breadcrumb).toHaveText(/Puzzles\s*›\s*Tutorial/);
  await expect(breadcrumb.getByRole("link")).toHaveCount(1);

  await page.getByRole("link", { name: "Back to difficulties" }).click();
  await expect(page).toHaveURL(/#\/puzzles$/);
  await expect(page.getByRole("heading", { name: "Choose a difficulty" })).toBeVisible();
});

test("legacy puzzle URL redirects to play page", async ({ page }) => {
  await page.goto("./#puzzle=huge");
  await expect(page.getByRole("heading", { name: "Grand Hall" })).toBeVisible();
  await expect(page).toHaveTitle("Grand Hall · Sokomind");
});

test("legacy custom URL redirects to editor page", async ({ page }) => {
  await page.goto("./#custom=test");
  await expect(page.getByRole("heading", { name: "Puzzle Editor" })).toBeVisible();
});

test("editor page loads at direct URL", async ({ page }) => {
  await page.goto("./#/editor");
  await expect(page.getByRole("heading", { name: "Puzzle Editor" })).toBeVisible();
  await expect(page).toHaveTitle("Puzzle Editor · Sokomind");
});

test("back button from play page navigates to puzzles", async ({ page }) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();

  await page.getByRole("link", { name: "Back to puzzles" }).click();
  await expect(page.getByRole("heading", { name: "Choose a difficulty" })).toBeVisible();
});

test("share control renders an outbound arrow instead of entity text", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");

  const share = page.getByRole("button", {
    name: "Share this puzzle and route",
  });
  await expect(share).toContainText("↗");
  await expect(share).toContainText("Share");
  await expect(share).not.toContainText("&nearr;");
});

test("invalid play links return home without overwriting the saved attempt", async ({
  page,
}) => {
  const savedAttempt = JSON.stringify({
    version: 1,
    puzzleId: "tutorial-push",
    actionLog: "ULUR",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  await page.addInitScript((serialized) => {
    localStorage.setItem("sokomind.session.v1", serialized);
  }, savedAttempt);

  for (const route of [
    "#/play/not-a-real-puzzle",
    `#/play/ultra-tiny?play=${"D".repeat(2_001)}`,
    // Lexically valid, but impossible: First Steps starts below a top wall.
    "#/play/ultra-tiny?play=U",
  ]) {
    await page.goto(`./${route}`);
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
    expect(
      await page.evaluate(() => localStorage.getItem("sokomind.session.v1")),
    ).toBe(savedAttempt);
  }
});

test("large collections use URL-addressable accessible pagination", async ({
  page,
}) => {
  await page.goto("./#/puzzles/beginner/Sokomind%20Generated?page=2");
  await expect(
    page.getByRole("heading", { name: "Sokomind Generated" }),
  ).toBeVisible();

  const rows = page.getByTestId("puzzle-row");
  await expect(rows).toHaveCount(50);
  const status = page.getByRole("status").filter({
    hasText: /Showing 51–100 of \d+ puzzles/,
  });
  await expect(status).toBeVisible();

  const pages = page.getByRole("navigation", {
    name: "Sokomind Generated puzzle pages",
  });
  await pages.getByRole("link", { name: "3", exact: true }).click();
  await expect(page).toHaveURL(/Sokomind%20Generated\?page=3$/);
  await expect(
    page.getByRole("status").filter({
      hasText: /Showing 101–150 of \d+ puzzles/,
    }),
  ).toBeFocused();
  await expect(rows).toHaveCount(50);

  const search = page.getByPlaceholder("Search");
  await search.pressSequentially("446");
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("446");
  await expect(page).toHaveURL(/Sokomind%20Generated$/);
  await expect(rows).toHaveCount(1);
});

test("puzzle lists restore filters, page, scroll, and row focus after play", async ({
  page,
}) => {
  await page.goto("./#/puzzles/beginner/Sokomind%20Generated?page=2");
  const search = page.getByRole("searchbox", { name: "Search puzzles" });
  const rows = page.getByTestId("puzzle-row");

  await search.fill("446");
  await expect(rows).toHaveCount(1);
  const filteredRow = rows.first();
  const filteredPuzzleId = await filteredRow.getAttribute("data-puzzle-id");
  const filteredPuzzleTitle = await filteredRow.locator("strong").textContent();
  await filteredRow.click();
  await page.getByRole("link", { name: "Back to puzzles" }).click();
  await expect(search).toHaveValue("446");
  await expect(page.locator(`[data-puzzle-id="${filteredPuzzleId}"]`)).toBeFocused();
  const recent = page.getByRole("complementary", {
    name: "Recently played puzzle",
  });
  await expect(recent).toContainText(filteredPuzzleTitle ?? "");
  await expect(recent.getByRole("link", { name: "Continue" })).toHaveAttribute(
    "href",
    `#/play/${filteredPuzzleId}`,
  );

  await search.fill("");
  await expect(rows).toHaveCount(50);
  await page.getByRole("link", { name: "2", exact: true }).click();
  const deepRow = rows.nth(40);
  await deepRow.scrollIntoViewIfNeeded();
  const savedScrollY = await page.evaluate(() => window.scrollY);
  const deepPuzzleId = await deepRow.getAttribute("data-puzzle-id");
  await deepRow.click();
  await page.getByRole("link", { name: "Back to puzzles" }).click();

  await expect(page).toHaveURL(/Sokomind%20Generated\?page=2$/);
  await expect(page.locator(`[data-puzzle-id="${deepPuzzleId}"]`)).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(
    Math.max(0, savedScrollY - 2),
  );
});
