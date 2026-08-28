import { expect, test, type Locator, type Page } from "@playwright/test";

async function visibleBounds(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error("Visible element has no layout bounds.");
  return bounds;
}

async function expectInsideViewport(page: Page, locator: Locator) {
  const bounds = await visibleBounds(locator);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The visual test requires a viewport.");
  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function setExperience(
  page: Page,
  preferences: {
    readonly motion?: "full" | "reduced";
    readonly appearance?: "light";
  },
) {
  await page.getByRole("button", { name: "Sound and motion settings" }).click();
  const settings = page.getByRole("dialog", { name: "Sound & motion" });
  if (preferences.motion) {
    await settings
      .getByRole("combobox", { name: /motion/i })
      .selectOption(preferences.motion);
  }
  if (preferences.appearance) {
    await settings
      .getByRole("combobox", { name: /appearance/i })
      .selectOption(preferences.appearance);
  }
  await settings.getByRole("button", { name: "Close" }).click();
}

test("critical Play surfaces retain visible geometry in light and dark themes", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  const board = page.getByTestId("game-board");
  const boardBounds = await visibleBounds(board);
  expect(boardBounds.width).toBeGreaterThan(120);
  expect(boardBounds.height).toBeGreaterThan(120);

  const lightSurface = await page.locator("body").evaluate((element) =>
    getComputedStyle(element).backgroundImage);
  await page.getByRole("button", { name: "Sound and motion settings" }).click();
  const settings = page.getByRole("dialog", { name: "Sound & motion" });
  await settings.getByRole("combobox", { name: /appearance/i }).selectOption("dark");
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const darkSurface = await page.locator("body").evaluate((element) =>
    getComputedStyle(element).backgroundImage);
  expect(darkSurface).not.toBe(lightSurface);
  await expectInsideViewport(page, board);

  await page.keyboard.press("ArrowDown");
  await expectInsideViewport(
    page,
    page.getByRole("dialog", { name: "First Steps" }),
  );
});

test("solver and editor workspaces stay within their reviewed layout bounds", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await page.getByRole("button", { name: "Open solver laboratory" }).click();
  await expectInsideViewport(page, page.getByRole("dialog", { name: "Find a route" }));

  await page.goto("./#/editor");
  const grid = page.getByTestId("editor-grid");
  const bounds = await visibleBounds(grid);
  expect(bounds.width).toBeGreaterThan(200);
  expect(bounds.height).toBeGreaterThan(200);
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight > document.documentElement.clientHeight,
  }));
  expect(overflow.horizontal).toBe(false);
});

test("light mode preserves distinct typed box and storage colors", async ({
  page,
}) => {
  await page.goto("./#/play/beginner-typed-line");
  await setExperience(page, { appearance: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const pieceBackgrounds = await page.evaluate(() => {
    const backgrounds = (selector: string) =>
      [...document.querySelectorAll<HTMLElement>(selector)].map((element) => ({
        label: element.dataset.boxLabel ?? element.dataset.goalLabel ?? "",
        image: getComputedStyle(element).backgroundImage,
      }));
    return {
      boxes: backgrounds("[data-box-label]"),
      goals: backgrounds("[data-goal-label]"),
    };
  });

  expect(pieceBackgrounds.boxes.map(({ label }) => label).sort()).toEqual(["A", "B", "C"]);
  expect(pieceBackgrounds.goals.map(({ label }) => label).sort()).toEqual(["A", "B", "C"]);
  for (const piece of [...pieceBackgrounds.boxes, ...pieceBackgrounds.goals]) {
    expect(piece.image).not.toBe("none");
  }
  expect(new Set(pieceBackgrounds.boxes.map(({ image }) => image)).size).toBe(3);
  expect(new Set(pieceBackgrounds.goals.map(({ image }) => image)).size).toBe(3);
});

test("the six-step route trail fades and shrinks with age", async ({ page }) => {
  await page.goto("./#/play/beginner-typed-line");
  await setExperience(page, { motion: "full" });
  await page.getByTestId("game-board").click();

  for (const key of [
    "ArrowLeft",
    "ArrowLeft",
    "ArrowLeft",
    "ArrowUp",
    "ArrowUp",
    "ArrowRight",
  ]) {
    await page.keyboard.press(key);
  }
  await expect(page.getByTestId("moves-count")).toHaveText("6");
  await expect(page.locator("[data-trail-age]")).toHaveCount(6);

  const presentation = await page.locator("[data-trail-age]").evaluateAll((markers) =>
    markers
      .map((marker) => {
        const style = getComputedStyle(marker, "::after");
        const matrix = new DOMMatrixReadOnly(style.transform);
        return {
          age: Number((marker as HTMLElement).dataset.trailAge),
          opacity: Number(style.opacity),
          scale: matrix.a,
        };
      })
      .sort((left, right) => left.age - right.age),
  );

  expect(presentation.map(({ age }) => age)).toEqual([0, 1, 2, 3, 4, 5]);
  for (let index = 1; index < presentation.length; index += 1) {
    expect(presentation[index].opacity).toBeLessThan(presentation[index - 1].opacity);
    expect(presentation[index].scale).toBeLessThan(presentation[index - 1].scale);
  }
});

test("rapid keeper input never animates farther than one adjacent cell", async ({
  page,
}) => {
  await page.goto("./#/play/beginner-typed-line");
  await setExperience(page, { motion: "full" });
  await page.getByTestId("game-board").click();

  const route = [
    "ArrowLeft",
    "ArrowLeft",
    "ArrowLeft",
    "ArrowUp",
    "ArrowUp",
    "ArrowRight",
  ];
  let observedAnimations = 0;
  for (const [index, key] of route.entries()) {
    await page.keyboard.press(key);
    await expect(page.getByTestId("moves-count")).toHaveText(String(index + 1));
    const translations = await page.locator('[data-piece-id="keeper"]').evaluate((slot) => {
      const layer = slot.parentElement;
      if (!layer) throw new Error("Keeper slot has no piece layer.");
      const layerStyle = getComputedStyle(layer);
      const layerRect = layer.getBoundingClientRect();
      const columns = Number(layerStyle.getPropertyValue("--columns"));
      const rows = Number(layerStyle.getPropertyValue("--rows"));
      const columnGap = Number.parseFloat(layerStyle.columnGap);
      const rowGap = Number.parseFloat(layerStyle.rowGap);
      const columnPitch = (layerRect.width - columnGap * (columns - 1)) / columns + columnGap;
      const rowPitch = (layerRect.height - rowGap * (rows - 1)) / rows + rowGap;
      return slot.getAnimations().flatMap((animation) =>
        (animation.effect as KeyframeEffect | null)?.getKeyframes().map((frame) => {
          const matrix = new DOMMatrixReadOnly(String(frame.transform));
          return {
            x: matrix.m41,
            y: matrix.m42,
            columnPitch,
            rowPitch,
          };
        }) ?? [],
      );
    });
    if (translations.length > 0) observedAnimations += 1;
    for (const translation of translations) {
      expect(Math.min(Math.abs(translation.x), Math.abs(translation.y))).toBeLessThan(0.75);
      expect(Math.abs(translation.x)).toBeLessThanOrEqual(translation.columnPitch + 1);
      expect(Math.abs(translation.y)).toBeLessThanOrEqual(translation.rowPitch + 1);
    }
  }
  expect(observedAnimations).toBeGreaterThan(1);

  const keeper = page.locator('[data-piece-id="keeper"]');
  await expect.poll(
    () => keeper.evaluate((slot) => slot.getAnimations().length),
    { timeout: 2_000 },
  ).toBe(0);
  const settled = await keeper.evaluate((slot) => {
    const layer = slot.parentElement;
    if (!layer) throw new Error("Keeper slot has no piece layer.");
    const layerStyle = getComputedStyle(layer);
    const layerRect = layer.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const columns = Number(layerStyle.getPropertyValue("--columns"));
    const rows = Number(layerStyle.getPropertyValue("--rows"));
    const column = Number((slot as HTMLElement).dataset.pieceColumn);
    const row = Number((slot as HTMLElement).dataset.pieceRow);
    const columnGap = Number.parseFloat(layerStyle.columnGap);
    const rowGap = Number.parseFloat(layerStyle.rowGap);
    const cellWidth = (layerRect.width - columnGap * (columns - 1)) / columns;
    const cellHeight = (layerRect.height - rowGap * (rows - 1)) / rows;
    return {
      activeAnimations: slot.getAnimations().length,
      leftError: Math.abs(slotRect.left - (layerRect.left + column * (cellWidth + columnGap))),
      topError: Math.abs(slotRect.top - (layerRect.top + row * (cellHeight + rowGap))),
      widthError: Math.abs(slotRect.width - cellWidth),
      heightError: Math.abs(slotRect.height - cellHeight),
    };
  });
  expect(settled.activeAnimations).toBe(0);
  expect(settled.leftError).toBeLessThan(1);
  expect(settled.topError).toBeLessThan(1);
  expect(settled.widthError).toBeLessThan(1);
  expect(settled.heightError).toBeLessThan(1);
});

test("movement feedback presents blocked recoil, push compression, and a goal ripple", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await setExperience(page, { motion: "full" });
  const board = page.getByTestId("game-board");
  const keeper = page.locator('[data-piece-id="keeper"]');
  await board.click();

  await page.keyboard.press("ArrowUp");
  await expect(board).toHaveAttribute("data-feedback", "blocked");
  await expect(board).toHaveAttribute("data-feedback-sequence", "1");
  await expect(keeper).toHaveAttribute("data-piece-feedback", "blocked");
  const firstRecoil = await keeper.evaluate((slot) =>
    slot.getAnimations().some((animation) =>
      (animation.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => {
        const matrix = new DOMMatrixReadOnly(String(frame.transform));
        return Math.abs(matrix.m41) > 2 || Math.abs(matrix.m42) > 2;
      }) ?? false,
    ));
  expect(firstRecoil).toBe(true);

  await page.keyboard.press("ArrowUp");
  await expect(board).toHaveAttribute("data-feedback-sequence", "2");
  const repeatedRecoil = await keeper.evaluate((slot) =>
    slot.getAnimations().length);
  expect(repeatedRecoil).toBeGreaterThan(0);

  await page.keyboard.press("ArrowDown");
  await expect(board).toHaveAttribute("data-feedback", "solved");
  await expect(page.locator('[data-feedback-effect="goal-ripple"]')).toHaveCount(1);
  const movedBox = page.locator('[data-piece-feedback="solved"]');
  const compressed = await movedBox.evaluate((slot) =>
    slot.getAnimations().some((animation) =>
      (animation.effect as KeyframeEffect | null)?.getKeyframes().some((frame) => {
        const matrix = new DOMMatrixReadOnly(String(frame.transform));
        return Math.abs(matrix.a - 1) > 0.01 || Math.abs(matrix.d - 1) > 0.01;
      }) ?? false,
    ));
  expect(compressed).toBe(true);
});

test("reduced motion preserves feedback state without transient board effects", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await setExperience(page, { motion: "reduced" });
  const board = page.getByTestId("game-board");
  const keeper = page.locator('[data-piece-id="keeper"]');
  await board.click();

  await page.keyboard.press("ArrowUp");
  await expect(board).toHaveAttribute("data-feedback", "blocked");
  expect(await keeper.evaluate((slot) => slot.getAnimations().length)).toBe(0);

  await page.keyboard.press("ArrowDown");
  await expect(board).toHaveAttribute("data-feedback", "solved");
  await expect(page.locator('[data-feedback-effect="goal-ripple"]')).toHaveCount(0);
  expect(
    await page.locator('[data-piece-feedback="solved"]').evaluate(
      (slot) => slot.getAnimations().length,
    ),
  ).toBe(0);
});

test("completion dialog reflows at 200 percent text size", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto("./#/play/ultra-tiny");
  await page.locator("html").evaluate((element) => {
    element.style.fontSize = "200%";
  });
  await page.getByTestId("game-board").click();
  await page.keyboard.press("ArrowDown");

  const dialog = page.getByRole("dialog", { name: "First Steps" });
  const bounds = await visibleBounds(dialog);
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The visual test requires a viewport.");
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);

  const next = dialog.getByRole("button", { name: "Next room" });
  await next.scrollIntoViewIfNeeded();
  await expectInsideViewport(page, next);
});
