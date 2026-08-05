import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

async function openExperienceControls(page: Page): Promise<Locator> {
  await page
    .getByRole("button", { name: "Sound and motion settings" })
    .click();
  const panel = page.getByRole("dialog", { name: "Sound & motion" });
  await expect(panel).toBeVisible();
  return panel;
}

async function openHowToPlay(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "How to play" }).click();
  const dialog = page.getByRole("dialog", { name: "How to play" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function readMotionStyles(page: Page, dialog: Locator) {
  const sheet = dialog.locator("section");
  const button = dialog.getByRole("button", { name: "Return to the room" });
  const robot = page.locator('[data-piece-id="keeper"] > span');

  return {
    animationDuration: await sheet.evaluate(
      (element) => getComputedStyle(element).animationDuration,
    ),
    transitionDuration: await button.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
    robotAnimationName: await robot.evaluate(
      (element) => getComputedStyle(element).animationName,
    ),
  };
}

function cssTimeListInMilliseconds(value: string): number[] {
  return value.split(",").map((part) => {
    const time = part.trim();
    return time.endsWith("ms") ? Number.parseFloat(time) : Number.parseFloat(time) * 1_000;
  });
}

function expectMotionSuppressed(styles: Awaited<ReturnType<typeof readMotionStyles>>) {
  expect(
    cssTimeListInMilliseconds(styles.animationDuration).every(
      (duration) => duration <= 0.01,
    ),
  ).toBe(true);
  expect(
    cssTimeListInMilliseconds(styles.transitionDuration).every(
      (duration) => duration <= 0.01,
    ),
  ).toBe(true);
  expect(styles.robotAnimationName).toBe("none");
}

async function expectAxeClean(page: Page, view: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations, `${view} accessibility violations`).toEqual([]);
}

test("resolved motion controls every animation and can override the OS preference", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();

  let settings = await openExperienceControls(page);
  await settings.getByRole("combobox", { name: /motion/i }).selectOption("reduced");
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");

  let help = await openHowToPlay(page);
  expectMotionSuppressed(await readMotionStyles(page, help));
  await help.getByRole("button", { name: "Close instructions" }).click();

  await page.emulateMedia({ reducedMotion: "reduce" });
  settings = await openExperienceControls(page);
  await settings.getByRole("combobox", { name: /motion/i }).selectOption("full");
  await settings.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "full");

  help = await openHowToPlay(page);
  const fullMotion = await readMotionStyles(page, help);
  expect(cssTimeListInMilliseconds(fullMotion.animationDuration)).toContain(240);
  expect(cssTimeListInMilliseconds(fullMotion.transitionDuration)).toContain(160);
  expect(fullMotion.robotAnimationName).toContain("keeper-breathe");

  await page.evaluate(() => {
    delete document.documentElement.dataset.motion;
  });
  expectMotionSuppressed(await readMotionStyles(page, help));
});

test("experience settings contains focus and restores it on close", async ({
  page,
}) => {
  await page.goto("./");
  const trigger = page.getByRole("button", { name: "Sound and motion settings" });
  await trigger.click();
  const settings = page.getByRole("dialog", { name: "Sound & motion" });
  await expect(settings.getByRole("button", { name: "Close" })).toBeFocused();
  expect(await settings.evaluate((dialog) =>
    dialog instanceof HTMLDialogElement && dialog.open)).toBe(true);

  await page.keyboard.press("Shift+Tab");
  expect(await settings.evaluate((dialog) =>
    dialog.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
});

test.describe("dark-theme accessibility", () => {
  test.skip(
    ({ browserName }) => browserName !== "chromium",
    "The representative multi-view audit runs once; structural scans cover every engine.",
  );

  test("representative views and a dialog pass axe", async ({ page }) => {
    await page.goto("./#/play/ultra-tiny");
    await expect(
      page.getByRole("heading", { name: "First Steps" }),
    ).toBeVisible();
    const settings = await openExperienceControls(page);
    await settings.getByRole("combobox", { name: /theme/i }).selectOption("dark");
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectAxeClean(page, "Play");

    const help = await openHowToPlay(page);
    await expectAxeClean(page, "How to play dialog");
    await help.getByRole("button", { name: "Close instructions" }).click();

    await page.goto("./");
    await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
    await expectAxeClean(page, "Home");

    await page.goto("./#/puzzles");
    await expect(
      page.getByRole("heading", { name: "Choose a difficulty" }),
    ).toBeVisible();
    await expectAxeClean(page, "Puzzle library");

    await page.goto("./#/editor");
    await expect(
      page.getByRole("heading", { name: "Puzzle Editor" }),
    ).toBeVisible();
    await expectAxeClean(page, "Editor");
  });
});
