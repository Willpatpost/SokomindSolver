import { expect, test, type Page } from "@playwright/test";

// Client coordinates of a cell centre, using the same padding-aware mapping
// as the board click handler.
async function cellCentre(page: Page, row: number, column: number) {
  return page.getByTestId("game-board").evaluate(
    (board, target) => {
      const rect = board.getBoundingClientRect();
      const style = getComputedStyle(board);
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padTop = parseFloat(style.paddingTop) || 0;
      const innerWidth = rect.width - padLeft - (parseFloat(style.paddingRight) || 0);
      const innerHeight = rect.height - padTop - (parseFloat(style.paddingBottom) || 0);
      return {
        x: rect.left + padLeft + ((target.column + 0.5) * innerWidth) / target.columns,
        y: rect.top + padTop + ((target.row + 0.5) * innerHeight) / target.rows,
      };
    },
    { row, column, columns: 9, rows: 6 },
  );
}

test("clicking a distant floor cell walks the whole route", async ({ page }) => {
  await page.goto("./#/play/beginner-typed-line");
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();

  // Keeper starts at row 4, column 4; row 4, column 1 is three steps left.
  const { x, y } = await cellCentre(page, 4, 1);
  await page.mouse.click(x, y);

  await expect(page.getByTestId("moves-count")).toHaveText("3");
  await expect(page.getByTestId("game-board")).toHaveAttribute(
    "aria-label",
    /Keeper at row 5, column 2\..*3 moves and 0 pushes/,
  );
});

// Dispatches synthetic touches on the board; browsers without TouchEvent skip.
async function dispatchTouches(
  page: Page,
  steps: readonly { type: string; x: number; y: number; active: boolean }[],
) {
  await page.getByTestId("game-board").evaluate((element, events) => {
    for (const { type, x, y, active } of events) {
      const touch = { clientX: x, clientY: y };
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: active ? [touch] : [] },
        changedTouches: { value: [touch] },
      });
      element.dispatchEvent(event);
    }
  }, steps);
}

test("a swipe survives the play timer re-rendering mid-gesture", async ({ page }) => {
  await page.clock.install();
  await page.goto("./#/play/beginner-typed-line");
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();
  test.skip(
    !(await page.evaluate(() => typeof TouchEvent !== "undefined")),
    "TouchEvent is unavailable in this browser",
  );

  // The first move starts the elapsed timer.
  await page.locator("#game-stage").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("moves-count")).toHaveText("1");

  await dispatchTouches(page, [{ type: "touchstart", x: 100, y: 100, active: true }]);
  await page.clock.runFor(2_500);
  await expect(page.getByTestId("elapsed-time")).toBeVisible();
  await dispatchTouches(page, [
    { type: "touchmove", x: 180, y: 100, active: true },
    { type: "touchend", x: 180, y: 100, active: false },
  ]);

  await expect(page.getByTestId("moves-count")).toHaveText("2");
});

test("play timer ticks do not rebind the game keyboard listener", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.addEventListener;
    let keydownBindings = 0;
    Object.defineProperty(window, "keydownBindings", { get: () => keydownBindings });
    window.addEventListener = function (this: Window, ...args: Parameters<typeof original>) {
      if (args[0] === "keydown") keydownBindings += 1;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.clock.install();
  await page.goto("./#/play/beginner-typed-line");
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();

  await page.locator("#game-stage").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("moves-count")).toHaveText("1");
  const bindings = () => page.evaluate(() => Reflect.get(window, "keydownBindings") as number);
  const before = await bindings();

  await page.clock.runFor(3_500);
  await expect(page.getByTestId("elapsed-time")).toBeVisible();
  expect(await bindings()).toBe(before);

  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("moves-count")).toHaveText("2");
});
