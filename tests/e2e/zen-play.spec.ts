import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("Zen mode is reversible, persistent, and keeps critical actions available", async ({
  page,
}) => {
  await page.goto("./#/play/beginner-typed-line");
  await page.getByRole("button", { name: "Enter Zen mode" }).click();

  const zenPage = page.locator("main[data-zen='true']");
  await expect(zenPage).toBeVisible();
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to puzzles" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo last move" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart room" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Sound and motion settings" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Exit Zen mode" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Game controls" })).toBeVisible();

  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("moves-count")).toHaveText("1");
  await page.getByRole("button", { name: "Undo last move" }).click();
  await expect(page.getByTestId("moves-count")).toHaveText("0");

  await page.getByRole("button", { name: "Sound and motion settings" }).click();
  await expect(page.getByRole("dialog", { name: "Sound & motion" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);

  await page.reload();
  await expect(page.locator("main[data-zen='true']")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const stored = localStorage.getItem("sokomind.experience.v2");
    return stored ? JSON.parse(stored).zenMode : null;
  })).toBe(true);

  await page.keyboard.press("z");
  await expect(page.locator("main[data-zen='true']")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter Zen mode" })).toBeVisible();
});

test("pausing locks keyboard and swipe movement until play resumes", async ({ page }) => {
  await page.goto("./#/play/beginner-typed-line");
  await expect(page.getByRole("button", { name: "Move left" })).toBeEnabled();
  await page.getByTestId("game-board").click();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("moves-count")).toHaveText("1");

  await page.keyboard.press("p");
  await expect(page.getByRole("alert", { name: "Game paused" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("moves-count")).toHaveText("1");

  await page.keyboard.press("u");
  await page.keyboard.press("r");
  await page.keyboard.press("PageDown");
  await page.keyboard.press("f");
  await page.keyboard.press("z");
  await expect(page.getByTestId("moves-count")).toHaveText("1");
  await expect(page.getByRole("dialog", { name: "Restart this room?" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add to favorites" })).toBeVisible();
  await expect(page.locator("main[data-zen='true']")).toHaveCount(0);

  const hasTouchEvent = await page.evaluate(() => typeof TouchEvent !== "undefined");
  if (hasTouchEvent) {
    await page.getByTestId("game-board").evaluate((element) => {
      const start = { clientX: 100, clientY: 100 };
      const end = { clientX: 180, clientY: 100 };
      const dispatch = (type: string, touches: typeof start[], changedTouches: typeof start[]) => {
        const event = new TouchEvent(type, { bubbles: true, cancelable: true });
        Object.defineProperties(event, {
          touches: { value: touches },
          changedTouches: { value: changedTouches },
        });
        element.dispatchEvent(event);
      };
      dispatch("touchstart", [start], [start]);
      dispatch("touchmove", [end], [end]);
      dispatch("touchend", [], [end]);
    });
    await expect(page.getByTestId("moves-count")).toHaveText("1");
  }

  await page.keyboard.press("p");
  await expect(page.getByRole("alert", { name: "Game paused" })).toHaveCount(0);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("moves-count")).toHaveText("2");
});

test("large boards scale within the viewport and gain space in Zen mode", async ({ page }) => {
  await page.goto("./#/play/open-field");
  const board = page.getByTestId("game-board");
  await expect(board).toHaveAttribute("data-board-size", "large");
  const normal = await board.boundingBox();
  expect(normal).not.toBeNull();

  await page.getByRole("button", { name: "Enter Zen mode" }).click();
  const immersive = await board.boundingBox();
  const viewport = page.viewportSize();
  expect(immersive).not.toBeNull();
  expect(viewport).not.toBeNull();
  if (normal && immersive && viewport) {
    expect(immersive.width).toBeGreaterThan(normal.width + 8);
    expect(immersive.x).toBeGreaterThanOrEqual(0);
    expect(immersive.y).toBeGreaterThanOrEqual(0);
    expect(immersive.x + immersive.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(immersive.width / 20).toBeGreaterThan(16);
  }
  expect(await page.evaluate(() =>
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  )).toBe(true);
});
