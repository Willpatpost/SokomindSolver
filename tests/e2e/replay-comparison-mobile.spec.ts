import { expect, test } from "@playwright/test";

test("replay study remains contained and operable on a phone viewport", async ({
  page,
}) => {
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByTestId("game-board").click();
  await page.keyboard.press("ArrowDown");
  const completion = page.getByRole("dialog", { name: "First Steps" });
  await completion.getByRole("button", { name: /Review and compare replay/u }).click();

  const replay = page.getByRole("dialog", { name: "First Steps" });
  await expect(replay).toBeVisible();
  const bounds = await replay.boundingBox();
  const viewport = page.viewportSize();
  expect(bounds).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.width).toBeLessThanOrEqual(viewport!.width);
  expect(bounds!.height).toBeLessThanOrEqual(viewport!.height);

  const slider = replay.getByRole("slider", { name: /Replay position/u });
  await slider.scrollIntoViewIfNeeded();
  await slider.fill("1");
  await expect(slider).toHaveValue("1");
  const close = replay.getByRole("button", { name: "Close replay study" });
  await close.scrollIntoViewIfNeeded();
  await close.click();
  await expect(replay).toBeHidden();
});
