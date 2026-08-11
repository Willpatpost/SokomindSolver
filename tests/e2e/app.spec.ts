import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByTestId("game-board").click();
});

test("loads below the Pages subpath and passes an accessibility scan", async ({
  page,
}) => {
  await expect(page).toHaveTitle("First Steps · Sokomind");
  await expect(page.getByTestId("game-board")).toHaveAttribute("role", "img");

  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(results.violations).toEqual([]);
});

test("solves a room and reports the new personal best", async ({ page }) => {
  await page.keyboard.press("ArrowDown");

  const dialog = page.getByRole("dialog", { name: "First Steps" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("First clear saved as your personal best");
  await expect(dialog).toContainText("1 Move");
  await expect(dialog).toContainText("1 Push");
});

test("restores an exact attempt after reload and keeps undo available", async ({
  page,
}) => {
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("moves-count")).toHaveText("1");

  await page.reload();
  await expect(page.getByTestId("moves-count")).toHaveText("1");
  await expect(page.getByText("Restored 1 saved move")).toBeVisible();

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByTestId("moves-count")).toHaveText("0");
});

test("modal dialogs isolate gameplay keys and restart protects progress", async ({
  page,
}) => {
  await page.getByRole("button", { name: "How to play" }).click();
  await expect(page.getByRole("dialog", { name: "How to play" })).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("moves-count")).toHaveText("0");
  await page.getByRole("button", { name: "Close instructions" }).click();

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("r");
  const reset = page.getByRole("dialog", { name: "Restart this room?" });
  await expect(reset).toBeVisible();
  await reset.getByRole("button", { name: "Keep playing" }).click();
  await expect(page.getByTestId("moves-count")).toHaveText("1");
});

test("deep-links to Grand Hall via legacy URL redirect", async ({ page }) => {
  await page.goto("./#puzzle=huge");
  await expect(page.getByRole("heading", { name: "Grand Hall" })).toBeVisible();
  await expect(page).toHaveTitle("Grand Hall · Sokomind");
});

test("persists explicit audio and reduced-motion preferences", async ({ page }) => {
  const audio = page.getByRole("button", { name: /all audio/ });
  const audioSupported = await audio.isEnabled();
  if (audioSupported) {
    await expect(audio).toHaveAccessibleName("Mute all audio");
    await expect(audio).toHaveAttribute("aria-pressed", "true");
  } else {
    await expect(audio).toBeDisabled();
  }

  await page
    .getByRole("button", { name: "Sound and motion settings" })
    .click();
  const settings = page.getByRole("dialog", { name: "Sound & motion" });
  if (audioSupported) {
    await expect(settings.getByRole("checkbox", { name: /all audio/i })).toBeChecked();
    await expect(settings.getByRole("checkbox", { name: /^music/i })).toBeChecked();
    await expect(settings.locator("output")).toHaveText(["50%", "50%"]);
  }
  await settings.getByRole("combobox", { name: /motion/i }).selectOption("reduced");
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
  await settings.getByRole("button", { name: "Close" }).click();

  if (audioSupported) {
    await page.getByRole("button", { name: "Mute all audio" }).click();
    await expect(
      page.getByRole("button", { name: "Turn on all audio" }),
    ).toHaveAttribute("aria-pressed", "false");
  }

  await page.reload();
  if (audioSupported) {
    await expect(
      page.getByRole("button", { name: "Turn on all audio" }),
    ).toHaveAttribute("aria-pressed", "false");
  } else {
    await expect(page.getByRole("button", { name: /all audio/ })).toBeDisabled();
  }
  await expect(page.locator("html")).toHaveAttribute("data-motion", "reduced");
});
