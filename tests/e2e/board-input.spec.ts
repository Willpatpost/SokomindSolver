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

interface Point {
  readonly x: number;
  readonly y: number;
}

interface TouchStep {
  readonly type: string;
  /** Fingers on the screen after this event. */
  readonly touches: readonly Point[];
  /** Fingers this event reports on; defaults to `touches`. */
  readonly changed?: readonly Point[];
}

// Dispatches synthetic touches on the board; browsers without TouchEvent skip.
async function dispatchTouches(page: Page, steps: readonly TouchStep[]) {
  await page.getByTestId("game-board").evaluate((element, events) => {
    const toTouches = (points: readonly Point[]) =>
      points.map(({ x, y }) => ({ clientX: x, clientY: y }));
    for (const { type, touches, changed } of events) {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: toTouches(touches) },
        changedTouches: { value: toTouches(changed ?? touches) },
      });
      element.dispatchEvent(event);
    }
  }, steps);
}

// Taps the board once or twice in one synchronous burst. Synthetic touches get
// no compatibility click, so each tap dispatches the click a browser would,
// which browsers skip when the touchstart was cancelled.
async function tapBoard(page: Page, point: Point, taps: 1 | 2) {
  await page.getByTestId("game-board").evaluate((board, { point, taps }) => {
    const touch = { clientX: point.x, clientY: point.y };
    const dispatchTouch = (type: string, active: boolean) => {
      const event = new TouchEvent(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        touches: { value: active ? [touch] : [] },
        changedTouches: { value: [touch] },
      });
      return board.dispatchEvent(event);
    };
    for (let tap = 0; tap < taps; tap += 1) {
      const started = dispatchTouch("touchstart", true);
      dispatchTouch("touchend", false);
      if (started) {
        board.dispatchEvent(
          new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
            clientX: point.x,
            clientY: point.y,
          }),
        );
      }
    }
  }, { point, taps });
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

  await dispatchTouches(page, [{ type: "touchstart", touches: [{ x: 100, y: 100 }] }]);
  await page.clock.runFor(2_500);
  await expect(page.getByTestId("elapsed-time")).toBeVisible();
  await dispatchTouches(page, [
    { type: "touchmove", touches: [{ x: 180, y: 100 }] },
    { type: "touchend", touches: [], changed: [{ x: 180, y: 100 }] },
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

test("zoomed pans and double taps do not move the keeper", async ({ page }) => {
  await page.clock.install();
  await page.goto("./#/play/beginner-typed-line");
  await expect(page.getByRole("heading", { name: "Color Line" })).toBeVisible();
  test.skip(
    !(await page.evaluate(() => typeof TouchEvent !== "undefined")),
    "TouchEvent is unavailable in this browser",
  );
  const layer = page.getByTestId("board-zoom-layer");
  const moves = page.getByTestId("moves-count");
  const box = await page.getByTestId("game-board").boundingBox();
  if (!box) throw new Error("board is not visible");
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);

  // Spreading two fingers from 40px to 60px apart about a fixed midpoint
  // zooms to 1.5x without panning.
  const spread = [{ x: x - 30, y }, { x: x + 30, y }];
  await dispatchTouches(page, [
    { type: "touchstart", touches: [{ x: x - 20, y }, { x: x + 20, y }] },
    { type: "touchmove", touches: spread },
    { type: "touchend", touches: [], changed: spread },
  ]);
  await expect(layer).toHaveCSS("transform", "matrix(1.5, 0, 0, 1.5, 0, 0)");

  // A one-finger drag pans the board instead of swiping the keeper.
  await page.clock.runFor(400);
  await dispatchTouches(page, [
    { type: "touchstart", touches: [{ x, y }] },
    { type: "touchmove", touches: [{ x: x + 40, y }] },
    { type: "touchend", touches: [], changed: [{ x: x + 40, y }] },
  ]);
  await expect(layer).toHaveCSS("transform", "matrix(1.5, 0, 0, 1.5, 40, 0)");
  await expect(moves).toHaveText("0");

  // A single tap still walks once the double-tap window has passed. The
  // keeper starts at row 4, column 4.
  await page.clock.runFor(400);
  await tapBoard(page, await cellCentre(page, 4, 3), 1);
  await page.clock.runFor(400);
  await expect(moves).toHaveText("1");

  // A double tap resets the zoom, and its first tap does not walk.
  await page.clock.runFor(400);
  await tapBoard(page, await cellCentre(page, 4, 2), 2);
  await expect(layer).toHaveCSS("transform", "none");
  await page.clock.runFor(1_000);
  await expect(moves).toHaveText("1");
});
