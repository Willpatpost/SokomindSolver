import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("./#/solver-lab/ultra-tiny");
  await expect(page.getByRole("heading", { name: "Solver Lab" })).toBeVisible();
});

test("presents an optional, documented search workspace", async ({ page }) => {
  await expect(page.getByLabel("Algorithm")).toHaveValue("sokomind-solver");
  await expect(page.getByRole("heading", { name: "Search setup" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "State-space population" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Solution path" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Side-by-side run comparison" })).toBeVisible();
  await expect(page.getByText("Counts are periodic snapshots", { exact: false })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Metrics have one definition everywhere" })).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("runs a worker search and steps through its replay-verified route", async ({ page }) => {
  await page.goto("./#/solver-lab/tutorial-push");
  await expect(page.getByRole("heading", { name: "One Push Wonder" })).toBeVisible();
  await page.getByLabel("Algorithm").selectOption("classic-astar");
  await page.getByRole("button", { name: "Run search" }).click();

  await expect(
    page.getByRole("region", { name: "Search setup" }).getByRole("status"),
  ).toHaveText(/^Found \d+ moves and \d+ pushes\.$/u);
  await expect(page.getByLabel("Watch result")).toBeVisible();
  await expect(page.getByTestId("solver-lab-board")).toBeVisible();

  const position = page.getByLabel("Solution playback position");
  await expect(position).toHaveValue("0");
  const total = Number(await position.getAttribute("max"));
  expect(total).toBeGreaterThan(1);
  await page.getByLabel("Speed").selectOption("0.5");
  await page.getByRole("button", { name: "Play route" }).click();
  const pause = page.getByRole("button", { name: "Pause playback" });
  await expect(pause).toBeVisible();
  await expect(position).toHaveValue("1", { timeout: 3_000 });
  await pause.click();
  const pausedAt = await position.inputValue();
  await page.waitForTimeout(1_200);
  await expect(position).toHaveValue(pausedAt);
  await page.getByRole("button", { name: "First" }).click();
  await expect(position).toHaveValue("0");
  await expect(page.getByRole("button", { name: "Play route" })).toBeVisible();
  await page.getByRole("button", { name: "Step forward" }).click();
  await expect(position).toHaveValue("1");
  await expect(page.getByText(new RegExp(`Move 1 of ${total} ·`, "u"))).toBeVisible();
});

test("compares two algorithms on the same position", async ({ page }) => {
  const algorithm = page.getByLabel("Algorithm");
  await algorithm.selectOption("classic-astar");
  await page.getByRole("button", { name: "Run search" }).click();
  await expect(
    page.getByRole("region", { name: "Search setup" }).getByRole("status"),
  ).toHaveText("Found 1 moves and 1 pushes.");
  await expect(page.getByText("1 of 6 runs")).toBeVisible();

  await algorithm.selectOption("classic-dfs");
  await page.getByRole("button", { name: "Run search" }).click();
  await expect(page.getByText("2 of 6 runs")).toBeVisible();
  await expect(page.getByText("Same puzzle and starting state")).toBeVisible();
  await expect(page.getByText("Limits match")).toBeVisible();
  await expect(page.getByLabel("Left result")).toBeVisible();
  await expect(page.getByLabel("Right result")).toBeVisible();
});

test("cancels a running search without replacing it with a late result", async ({ page }) => {
  await page.goto("./#/solver-lab/huge");
  await expect(page.getByRole("heading", { name: "Grand Hall" })).toBeVisible();
  await page.getByLabel("Algorithm").selectOption("classic-astar");
  await page.getByLabel("Time limit").selectOption("120000");

  await page.getByRole("button", { name: "Run search" }).click();
  const cancel = page.getByRole("button", { name: "Cancel search" });
  await expect(cancel).toBeEnabled();
  await cancel.click();

  const setupStatus = page
    .getByRole("region", { name: "Search setup" })
    .getByRole("status");
  await expect(setupStatus).toHaveText("Search cancelled.");
  await expect(page.getByText("1 of 6 runs")).toBeVisible();
  await page.waitForTimeout(250);
  await expect(setupStatus).toHaveText("Search cancelled.");
});

test("opens from regular play at the exact legal position", async ({ page }) => {
  await page.goto("./#/play/ultra-tiny");
  await page.getByRole("button", { name: "Open solver laboratory" }).click();
  const dialog = page.getByRole("dialog", { name: "Find a route" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("link", { name: "Open full Solver Lab" }).click();

  await expect(page.getByRole("heading", { name: "Solver Lab" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await expect(page.getByText("Initial position", { exact: true })).toBeVisible();
});
