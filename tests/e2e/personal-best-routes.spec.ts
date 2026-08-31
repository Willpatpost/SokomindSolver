import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

interface StoredRouteRepository {
  readonly version?: number;
  readonly puzzles?: Record<string, {
    readonly puzzleFingerprint?: string;
    readonly routes?: readonly {
      readonly actionLog?: string;
      readonly moves?: number;
      readonly pushes?: number;
      readonly validation?: string;
    }[];
  }>;
}

async function readRouteRepository(page: Page): Promise<StoredRouteRepository | null> {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("sokomind", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction("kv", "readonly");
      const request = transaction.objectStore("kv").get(
        "sokomind.personal-best-routes.v1",
      );
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(
        (request.result as StoredRouteRepository | undefined) ?? null,
      );
      transaction.oncomplete = () => database.close();
    };
  }));
}

test("retains replay-verified personal-best history and exposes storage controls", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByTestId("game-board").click();

  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  let completion = page.getByRole("dialog", { name: "First Steps" });
  await expect(completion).toContainText("3 Moves");
  await expect.poll(async () => {
    const repository = await readRouteRepository(page);
    return repository?.puzzles?.["ultra-tiny"]?.routes?.map((route) => route.moves);
  }).toEqual([3]);

  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("region", { name: "Game controls" })
    .getByRole("button", { name: /^Restart/u }).click();
  await page.getByRole("dialog", { name: "Restart this room?" })
    .getByRole("button", { name: "Restart room" }).click();
  await page.keyboard.press("ArrowDown");
  completion = page.getByRole("dialog", { name: "First Steps" });
  await expect(completion).toContainText("1 Move");

  await expect.poll(async () => {
    const repository = await readRouteRepository(page);
    return repository?.puzzles?.["ultra-tiny"]?.routes?.map((route) => ({
      actionLog: route.actionLog,
      moves: route.moves,
      pushes: route.pushes,
      validation: route.validation,
    }));
  }).toEqual([
    { actionLog: "D", moves: 1, pushes: 1, validation: "replay-verified" },
    { actionLog: "LRD", moves: 3, pushes: 1, validation: "replay-verified" },
  ]);

  const repository = await readRouteRepository(page);
  expect(repository?.version).toBe(1);
  expect(repository?.puzzles?.["ultra-tiny"]?.puzzleFingerprint)
    .toMatch(/^puzzle-v1:[0-9a-f]{8}$/u);

  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("button", { name: "Open progress" }).click();
  const progress = page.getByRole("dialog", { name: "Your progress" });
  await expect(progress).toContainText("2 routes across 1 puzzle");
  await expect(progress.getByTestId("completed-count")).toHaveText("1");

  const accessibility = await new AxeBuilder({ page })
    .include("dialog[open]")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await progress.getByRole("button", { name: "Clear replay history" }).click();
  await progress.getByRole("button", { name: "Clear routes" }).click();
  await expect(progress.getByRole("status")).toContainText(
    "Personal-best summaries remain",
  );
  await expect(progress).toContainText("No replay routes saved yet");
  await expect(progress.getByTestId("completed-count")).toHaveText("1");
  await expect.poll(() => readRouteRepository(page)).toEqual({
    version: 1,
    resetGeneration: 1,
    puzzles: {},
  });
});

test("quota-limited route storage never prevents play or summary progress", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "indexedDB", {
      configurable: true,
      value: {
        open() {
          throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        },
      },
    });
  });
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByTestId("game-board").click();
  await page.keyboard.press("ArrowDown");

  const completion = page.getByRole("dialog", { name: "First Steps" });
  await expect(completion).toContainText("First clear saved as your personal best");
  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("button", { name: "Open progress" }).click();
  const progress = page.getByRole("dialog", { name: "Your progress" });
  await expect(progress.getByTestId("completed-count")).toHaveText("1");
  await expect(progress).toContainText(
    "Replay storage is unavailable. Puzzle play and summary records still work.",
  );
});
