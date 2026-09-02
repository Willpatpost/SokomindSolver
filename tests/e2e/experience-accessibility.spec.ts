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

test("audio previews and the mute shortcut expose accessible feedback", async ({
  page,
}) => {
  await page.goto("./");
  const audio = page.getByRole("button", { name: /all audio/ });
  test.skip(!(await audio.isEnabled()), "Web Audio is unavailable in this browser.");

  await expect(audio).toHaveAttribute("aria-keyshortcuts", "M");
  await page.keyboard.press("m");
  await expect(audio).toHaveAccessibleName("Turn on all audio");
  await expect(page.getByTestId("audio-status")).toContainText("Audio muted.");

  await page.keyboard.press("m");
  await expect(audio).toHaveAccessibleName("Mute all audio");
  await expect(page.getByTestId("audio-status")).toContainText("Audio on.");

  const settings = await openExperienceControls(page);
  await settings
    .getByRole("button", { name: "Preview effects at current volume" })
    .click();
  await expect(settings.getByTestId("audio-preview-status")).toHaveText(
    /Effects preview (played|could not play)\./,
  );

  await settings
    .getByRole("button", { name: "Preview music at current volume" })
    .click();
  await expect(settings.getByTestId("audio-preview-status")).toHaveText(
    /Music preview (played|could not play)\./,
  );
  await expectAxeClean(page, "Sound and motion settings");

  await page.keyboard.press("m");
  await expect(audio).toHaveAccessibleName("Mute all audio");
});

test("legacy appearance migrates to Cozy Study and the version 2 key", async ({
  page,
}) => {
  await page.goto("./");
  await page.waitForFunction(
    () => localStorage.getItem("sokomind.experience.v2") !== null,
  );
  await page.evaluate(() => {
    localStorage.removeItem("sokomind.experience.v2");
    localStorage.setItem("sokomind.experience.v1", JSON.stringify({
      version: 1,
      soundEnabled: false,
      musicEnabled: true,
      effectsVolume: 0.4,
      musicVolume: 0.6,
      motion: "reduced",
      theme: "dark",
    }));
  });
  await page.reload();

  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-family",
    "cozy-study",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const settings = await openExperienceControls(page);
  await expect(
    settings.getByRole("radio", { name: "Cozy Study" }),
  ).toBeChecked();
  await expect(
    settings.getByRole("combobox", { name: /appearance/i }),
  ).toHaveValue("dark");

  const stored = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("sokomind.experience.v2") ?? "null") as {
      version?: number;
      themeFamily?: string;
      appearance?: string;
    } | null,
  );
  expect(stored).toMatchObject({
    version: 2,
    themeFamily: "cozy-study",
    appearance: "dark",
  });
});

test("every theme family works in both appearances without board reflow", async ({
  browserName,
  context,
  page,
}) => {
  test.skip(
    browserName !== "chromium",
    "The six-variant contrast matrix runs once in Chromium.",
  );
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("./#/play/ultra-tiny");
  const board = page.getByTestId("game-board");
  const initialBounds = await board.boundingBox();
  if (!initialBounds) throw new Error("The board has no layout bounds.");

  const families = [
    ["cozy-study", "Cozy Study"],
    ["midnight-neon", "Midnight Neon"],
    ["minimal-ink", "Minimal Ink"],
  ] as const;
  const fingerprints = new Set<string>();

  for (const [family, label] of families) {
    for (const appearance of ["light", "dark"] as const) {
      const settings = await openExperienceControls(page);
      await settings.getByRole("radio", { name: label }).click();
      await settings
        .getByRole("combobox", { name: /appearance/i })
        .selectOption(appearance);

      // The preview is live while the settings dialog remains open.
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme-family",
        family,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        appearance,
      );
      await settings.getByRole("button", { name: "Close" }).click();

      const bounds = await board.boundingBox();
      if (!bounds) throw new Error("The themed board has no layout bounds.");
      expect(bounds.width).toBeCloseTo(initialBounds.width, 1);
      expect(bounds.height).toBeCloseTo(initialBounds.height, 1);

      const fingerprint = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const boardElement = document.querySelector<HTMLElement>(
          '[data-testid="game-board"]',
        );
        const firstCell = boardElement?.firstElementChild as HTMLElement | null;
        return [
          root.getPropertyValue("--paper-50").trim(),
          root.getPropertyValue("--sage-700").trim(),
          boardElement ? getComputedStyle(boardElement).backgroundColor : "",
          firstCell ? getComputedStyle(firstCell).backgroundColor : "",
        ].join("|");
      });
      fingerprints.add(fingerprint);

      const trigger = page.getByRole("button", {
        name: "Sound and motion settings",
      });
      await trigger.focus();
      expect(await trigger.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).outlineWidth))).toBeGreaterThan(0);
      await expectAxeClean(page, `${label} ${appearance}`);
    }
  }

  expect(fingerprints.size).toBe(6);

  let settings = await openExperienceControls(page);
  await settings
    .getByRole("combobox", { name: /appearance/i })
    .selectOption("system");
  await settings.getByRole("button", { name: "Close" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await context.setOffline(true);
  settings = await openExperienceControls(page);
  await settings.getByRole("radio", { name: "Midnight Neon" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme-family",
    "midnight-neon",
  );
  await context.setOffline(false);
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
    await settings.getByRole("combobox", { name: /appearance/i }).selectOption("dark");
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
