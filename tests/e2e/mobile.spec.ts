import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("keeps Help and movement controls reachable on mobile", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();

  await page.getByRole("button", { name: "How to play" }).click();
  await expect(page.getByRole("dialog", { name: "How to play" })).toBeVisible();
  await page.getByRole("button", { name: "Close instructions" }).click();

  const controls = page.getByRole("region", { name: "Game controls" });
  const score = page.getByText("Current route").locator("..").locator("..");
  await expect(controls).toBeVisible();
  expect((await controls.boundingBox())?.y).toBeLessThan(
    (await score.boundingBox())?.y ?? Infinity,
  );

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("homepage loads and navigates to puzzles", async ({ page }) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  await expect(page).toHaveTitle("Sokomind");

  await page.getByRole("button", { name: "Browse puzzles" }).click();
  await expect(page.getByRole("heading", { name: "Choose a difficulty" })).toBeVisible();
});

test("a real touch swipe crosses the board event boundary and moves the keeper", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  const board = page.getByTestId("game-board");
  await expect(board).toBeVisible();

  await board.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const start = {
      clientX: bounds.left + bounds.width / 2,
      clientY: bounds.top + bounds.height / 2,
    };
    const end = {
      clientX: start.clientX + 80,
      clientY: start.clientY,
    };

    const dispatchTouch = (
      type: "touchstart" | "touchmove" | "touchend",
      touches: typeof start[],
      changedTouches: typeof start[],
    ) => {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: touches },
        changedTouches: { value: changedTouches },
      });
      element.dispatchEvent(event);
    };

    // WebKit exposes TouchEvent but intentionally disallows the Touch
    // constructor. Supplying the same coordinate-bearing TouchList shape keeps
    // this test portable while still crossing the native touch-event boundary.
    dispatchTouch("touchstart", [start], [start]);
    dispatchTouch("touchmove", [end], [end]);
    dispatchTouch("touchend", [], [end]);
  });

  await expect(page.getByTestId("moves-count")).toHaveText("1");
});

test("ambiguous diagonal gestures do not cause accidental moves", async ({ page }) => {
  await page.goto("./#/play/beginner-typed-line");
  const board = page.getByTestId("game-board");
  await expect(board).toBeVisible();

  const swipe = async (deltaX: number, deltaY: number) => {
    await board.evaluate((element, delta) => {
      const bounds = element.getBoundingClientRect();
      const start = {
        clientX: bounds.left + bounds.width / 2,
        clientY: bounds.top + bounds.height / 2,
      };
      const end = {
        clientX: start.clientX + delta.deltaX,
        clientY: start.clientY + delta.deltaY,
      };
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
    }, { deltaX, deltaY });
  };

  await swipe(-70, 65);
  await expect(page.getByTestId("moves-count")).toHaveText("0");
  await swipe(-80, 8);
  await expect(page.getByTestId("moves-count")).toHaveText("1");
});
