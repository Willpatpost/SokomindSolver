import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function saveTwoPersonalBests(page: Page) {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByTestId("game-board").click();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");

  let completion = page.getByRole("dialog", { name: "First Steps" });
  await expect(completion).toContainText("3 Moves");
  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("region", { name: "Game controls" })
    .getByRole("button", { name: /^Restart/u }).click();
  await page.getByRole("dialog", { name: "Restart this room?" })
    .getByRole("button", { name: "Restart room" }).click();
  await page.keyboard.press("ArrowDown");
  completion = page.getByRole("dialog", { name: "First Steps" });
  await expect(completion).toContainText("1 Move");
  return completion;
}

test("completion and statistics expose an accessible controllable route comparison", async ({
  page,
}) => {
  const completion = await saveTwoPersonalBests(page);
  await completion.getByRole("button", { name: /Review and compare replay/u }).click();

  let replay = page.getByRole("dialog", { name: "First Steps" });
  await expect(replay.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await expect(replay.getByLabel("Watch")).toHaveValue("current");
  await expect(replay.getByLabel("Compare with")).toContainText("Earlier best 1");
  await expect(replay).toContainText("then the watched route goes down while the comparison goes left");
  await expect(replay.getByRole("button", { name: /Direction changes at move 1/u })).toBeVisible();
  await expect(replay.getByRole("button", { name: /shorter route finishes at move 1/u })).toBeVisible();

  const slider = replay.getByRole("slider", { name: /Replay position/u });
  await slider.focus();
  await slider.press("End");
  await expect(slider).toHaveValue("1");
  await expect(replay.getByRole("status")).toContainText("Puzzle solved");

  await replay.getByLabel("Replay speed").selectOption("2");
  await expect(replay.getByLabel("Replay speed")).toHaveValue("2");
  await replay.getByLabel("Show comparison ghost").check();
  await expect(replay.getByTestId("replay-ghost")).toBeVisible();
  await expect(replay.getByTestId("replay-board")).toHaveAttribute("role", "img");

  const accessibility = await new AxeBuilder({ page })
    .include("dialog[open]")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await replay.getByRole("button", { name: "Close replay study" }).click();
  await expect(page.getByTestId("game-board")).toHaveAttribute("data-solved", "true");
  await expect(page.getByTestId("game-board")).toHaveAttribute(
    "aria-label",
    /1 move and 1 push/u,
  );
  await page.goto("./#/stats");
  await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
  const shelf = page.getByRole("region", { name: "Personal-best replays" });
  await expect(shelf.getByRole("button", { name: "Study replay" })).toBeVisible();
  await expect(shelf).toContainText("2 routes");
  await shelf.getByRole("button", { name: "Study replay" }).click();
  replay = page.getByRole("dialog", { name: "First Steps" });
  await expect(replay.getByLabel("Watch")).toContainText("Personal best");
  await expect(replay.getByLabel("Compare with")).toContainText("Earlier best 1");
});

test("a single saved route still provides replay, seek, speed, and textual state", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByRole("button", { name: "Sound and motion settings" }).click();
  const settings = page.getByRole("dialog", { name: "Sound & motion" });
  await settings.getByRole("combobox", { name: /motion/i }).selectOption("reduced");
  await settings.getByRole("button", { name: "Close" }).click();
  await page.getByTestId("game-board").click();
  await page.keyboard.press("ArrowDown");
  const completion = page.getByRole("dialog", { name: "First Steps" });
  await completion.getByRole("button", { name: /Review and compare replay/u }).click();
  const replay = page.getByRole("dialog", { name: "First Steps" });

  await expect(replay).toContainText("Save another improved personal best");
  await expect(replay).toContainText("Reduced motion is on. Frames update instantly");
  await expect(replay.getByLabel("Compare with")).toBeDisabled();
  await replay.getByRole("button", { name: "Play replay" }).click();
  await expect(replay.getByRole("button", { name: "Play replay" })).toBeVisible();
  await expect(replay.getByRole("status")).toContainText("Puzzle solved");
});
