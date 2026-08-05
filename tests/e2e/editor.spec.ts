import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

interface SharedPuzzle {
  readonly title: string;
  readonly rows: readonly string[];
  readonly difficulty?: string;
  readonly hint?: string;
}

function editorUrl(puzzle: SharedPuzzle): string {
  const encoded = Buffer.from(
    JSON.stringify({
      t: puzzle.title,
      d: puzzle.difficulty ?? "beginner",
      ...(puzzle.hint ? { h: puzzle.hint } : {}),
      r: puzzle.rows,
    }),
    "utf8",
  ).toString("base64url");
  return `./#/editor?custom=${encoded}`;
}

const QUICK_TEST: SharedPuzzle = {
  title: "Quick editor test",
  hint: "Keep this draft intact.",
  rows: ["OOOOO", "O R O", "O X O", "O S O", "OOOOO"],
};

function createLargeTest(): SharedPuzzle {
  const rows = Array.from({ length: 20 }, (_, row) =>
    row === 0 || row === 19
      ? "O".repeat(20)
      : `O${" ".repeat(18)}O`,
  );
  const setCell = (row: number, column: number, symbol: string) => {
    rows[row] =
      rows[row].slice(0, column) +
      symbol +
      rows[row].slice(column + 1);
  };
  setCell(1, 1, "R");
  setCell(2, 1, "X");
  setCell(3, 1, "S");
  return { title: "Large editor test", rows };
}

async function contrastRatio(
  page: Page,
  selector: string,
  backgroundSelector = selector,
): Promise<number> {
  return page.locator(selector).first().evaluate((element, background) => {
    const parse = (value: string): [number, number, number] => {
      const channels = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Bad color: ${value}`);
      return channels as [number, number, number];
    };
    const luminance = ([red, green, blue]: [number, number, number]) => {
      const channels = [red, green, blue].map((channel) => {
        const value = channel / 255;
        return value <= 0.04045
          ? value / 12.92
          : ((value + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    };

    const backgroundElement = document.querySelector(background);
    if (!backgroundElement) throw new Error(`Missing background: ${background}`);
    const style = getComputedStyle(element);
    const backgroundStyle = getComputedStyle(backgroundElement);
    const foreground = luminance(parse(style.color));
    const backgroundLuminance = luminance(
      parse(backgroundStyle.backgroundColor),
    );
    return (
      (Math.max(foreground, backgroundLuminance) + 0.05) /
      (Math.min(foreground, backgroundLuminance) + 0.05)
    );
  }, backgroundSelector);
}

test("keeps the canvas readable and exposes all legal typed labels", async ({
  page,
}) => {
  await page.goto(editorUrl(QUICK_TEST));
  await expect(page.getByRole("heading", { name: "Puzzle Editor" })).toBeVisible();

  const firstCell = page
    .getByTestId("editor-grid")
    .locator("button")
    .first();
  const cellBox = await firstCell.boundingBox();
  expect(cellBox?.width).toBeGreaterThanOrEqual(36);
  expect(cellBox?.height).toBeGreaterThanOrEqual(36);

  const grid = page.getByRole("grid", { name: "Puzzle editor grid" });
  const gridCells = grid.getByRole("gridcell");
  await expect(gridCells).toHaveCount(25);
  await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
  await gridCells.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(gridCells.nth(1)).toBeFocused();
  await expect(grid.locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("End");
  await expect(gridCells.nth(4)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Title")).toBeFocused();

  const labelSelector = page.getByRole("combobox", { name: "Label" });
  const labels = await labelSelector.locator("option").allTextContents();
  expect(labels).toHaveLength(22);
  expect(labels).toContain("A");
  expect(labels).toContain("Z");
  expect(labels).not.toContain("O");
  expect(labels).not.toContain("R");
  expect(labels).not.toContain("S");
  expect(labels).not.toContain("X");

  await labelSelector.selectOption("Z");
  const typedBox = page.getByRole("button", {
    name: "Typed box Z",
    exact: true,
  });
  await typedBox.click();
  await expect(typedBox).toHaveAttribute("aria-pressed", "true");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("playtest is fully playable and returns to the unchanged draft", async ({
  page,
}) => {
  await page.goto(editorUrl(QUICK_TEST));
  await expect(page.getByLabel("Title")).toHaveValue(QUICK_TEST.title);
  await expect(page.getByLabel("Hint")).toHaveValue(QUICK_TEST.hint ?? "");
  const storageKeysBefore = await page.evaluate(() => Object.keys(localStorage));

  await page
    .getByRole("button", { name: "Sound and motion settings" })
    .click();
  await page.getByRole("combobox", { name: /motion/i }).selectOption("reduced");
  await page.getByRole("combobox", { name: /theme/i }).selectOption("dark");
  await page.getByRole("button", { name: "Close" }).click();

  const testButton = page.getByRole("button", { name: "Test puzzle" });
  await testButton.click();
  const playtestHeading = page.getByRole("heading", {
    name: QUICK_TEST.title,
    level: 2,
  });
  await expect(playtestHeading).toBeFocused();
  await expect(
    page.getByRole("region", { name: `Playtest ${QUICK_TEST.title}` }),
  ).toBeVisible();
  expect(
    await contrastRatio(
      page,
      '[aria-label="Playtest counters"] span',
      'aside[aria-label="Playtest controls"]',
    ),
  ).toBeGreaterThanOrEqual(4.5);
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("editor-playtest-moves")).toHaveText("1");
  await expect(page.getByText("Solved in 1 move")).toBeVisible();
  const activeAnimations = await page
    .getByTestId("editor-playtest-board")
    .evaluate(
      (board) =>
        [...board.querySelectorAll<HTMLElement>("[data-piece-id]")]
          .flatMap((piece) => piece.getAnimations())
          .filter((animation) => animation.playState === "running").length,
    );
  expect(activeAnimations).toBe(0);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("editor-playtest-moves")).toHaveText("0");
  await page.getByRole("button", { name: "Move down" }).click();
  await expect(page.getByText("Solved in 1 move")).toBeVisible();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.getByTestId("editor-playtest-moves")).toHaveText("0");

  await page.getByRole("button", { name: "Back to editor" }).click();
  await expect(testButton).toBeFocused();
  await expect(page.getByLabel("Title")).toHaveValue(QUICK_TEST.title);
  await expect(page.getByLabel("Hint")).toHaveValue(QUICK_TEST.hint ?? "");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(
    storageKeysBefore,
  );
});

test("contains a 20 by 20 board in a two-axis scroll viewport", async ({
  page,
}) => {
  await page.goto("./#/editor");
  await page.getByRole("spinbutton", { name: "Board width" }).fill("20");
  await page.getByRole("spinbutton", { name: "Board height" }).fill("20");

  const dimensions = await page
    .getByTestId("editor-grid-viewport")
    .evaluate((viewport) => ({
      clientWidth: viewport.clientWidth,
      clientHeight: viewport.clientHeight,
      scrollWidth: viewport.scrollWidth,
      scrollHeight: viewport.scrollHeight,
    }));
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  const cellBox = await page
    .getByTestId("editor-grid")
    .locator("button")
    .first()
    .boundingBox();
  expect(cellBox?.width).toBeGreaterThanOrEqual(36);
});

test("keeps a 20 by 20 playtest scrollable and uses the full tablet width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(editorUrl(createLargeTest()));
  await page.getByRole("button", { name: "Test puzzle" }).click();

  const playtestViewport = page.getByTestId("editor-playtest-viewport");
  const overflow = await playtestViewport.evaluate((viewport) => ({
    vertical: viewport.scrollHeight > viewport.clientHeight,
    overflowY: getComputedStyle(viewport).overflowY,
  }));
  expect(overflow.vertical).toBe(true);
  expect(overflow.overflowY).toBe("auto");

  await page.setViewportSize({ width: 700, height: 800 });
  await page.goto(editorUrl(QUICK_TEST));
  await page.getByRole("button", { name: "Test puzzle" }).click();
  const tabletLayout = await page
    .getByTestId("editor-playtest-layout")
    .evaluate((layout) => {
      const viewport = layout.querySelector<HTMLElement>(
        '[data-testid="editor-playtest-viewport"]',
      );
      if (!viewport) throw new Error("Playtest viewport missing");
      return {
        layoutWidth: layout.getBoundingClientRect().width,
        viewportWidth: viewport.getBoundingClientRect().width,
      };
    });
  expect(tabletLayout.viewportWidth / tabletLayout.layoutWidth).toBeGreaterThan(
    0.95,
  );
});

test("shares URL-safe data, reports failures, and keeps the dark primary legible", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(browserName !== "chromium", "clipboard permissions only supported in Chromium");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(editorUrl(QUICK_TEST));
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });

  const testButton = page.getByRole("button", { name: "Test puzzle" });
  await expect(testButton).toBeEnabled();
  expect(await contrastRatio(page, "button[data-primary]")).toBeGreaterThanOrEqual(
    4.5,
  );
  const clearButton = page.getByRole("button", { name: "Clear board" });
  await clearButton.hover();
  expect(await contrastRatio(page, "button[data-danger]")).toBeGreaterThanOrEqual(
    4.5,
  );

  await page.getByRole("button", { name: "Share (copy URL)" }).click();
  await expect(page.getByText("Share link copied to the clipboard")).toBeVisible();
  const shareUrl = await page.getByLabel("Share link").inputValue();
  expect(shareUrl).toMatch(/[?&]custom=[A-Za-z0-9_-]+$/);

  await page.evaluate(() => {
    window.location.hash = "#/editor?custom=not-valid-data";
  });
  await expect(page.getByRole("alert")).toContainText(
    "invalid or incomplete",
  );
  await expect(page.getByLabel("Title")).toHaveValue(QUICK_TEST.title);
});

test("does not publish a stale clipboard result after the draft changes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            (
              window as typeof window & {
                finishEditorClipboard?: () => void;
              }
            ).finishEditorClipboard = resolve;
          }),
      },
    });
  });
  await page.goto(editorUrl(QUICK_TEST));

  await page.getByRole("button", { name: "Share (copy URL)" }).click();
  await expect(page.getByLabel("Share link")).toBeVisible();
  await page.getByLabel("Title").fill("Edited during clipboard write");
  await expect(page.getByLabel("Share link")).toHaveCount(0);

  await page.evaluate(() => {
    (
      window as typeof window & {
        finishEditorClipboard?: () => void;
      }
    ).finishEditorClipboard?.();
  });
  await page.waitForTimeout(0);
  await expect(page.getByRole("status").filter({ hasNotText: /^$/ })).toHaveCount(0);
});
