import { expect, test } from "@playwright/test";

test("stats import enforces bounds and reports unchanged and rejected records", async ({
  page,
}) => {
  const same = {
    moves: 5,
    pushes: 1,
    completedAt: "2026-08-11T12:00:00.000Z",
  };
  await page.addInitScript(({ first }) => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      generation: 1,
      revision: 1,
      writerId: "stats-import-test",
      completed: {
        "ultra-tiny": first,
        "first-steps": {
          moves: 6,
          pushes: 1,
          completedAt: "2026-08-11T12:01:00.000Z",
        },
      },
      daily: {},
    }));
  }, { first: same });
  await page.goto("./#/stats");

  const input = page.locator('input[type="file"]');
  await input.setInputFiles({
    name: "progress.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      version: 2,
      completed: {
        "ultra-tiny": same,
        "first-steps": {
          moves: 7,
          pushes: 1,
          completedAt: "2026-08-11T12:02:00.000Z",
        },
        "not-in-the-catalog": {
          moves: 1,
          pushes: 0,
          completedAt: "2026-08-11T12:03:00.000Z",
        },
      },
      daily: {},
    })),
  });
  await expect(page.getByRole("status").filter({ hasText: "No changes:" }))
    .toContainText("0 added, 0 improved, 1 unchanged, 2 rejected, 0 invalid");

  await input.setInputFiles({
    name: "oversized.json",
    mimeType: "application/json",
    buffer: Buffer.from("x".repeat(1_000_001)),
  });
  await expect(page.getByRole("status").filter({ hasText: "too large" }))
    .toBeVisible();
});

test("reset all progress preserves every non-progress ownership domain", async ({
  page,
}) => {
  await page.goto("./");
  const preserved = {
    experience: JSON.stringify({
      version: 1,
      soundEnabled: true,
      musicEnabled: true,
      effectsVolume: 0.37,
      musicVolume: 0.63,
      motion: "reduced",
      theme: "dark",
    }),
    session: "session-sentinel",
    optimal: "proof-sentinel",
    ratings: "ratings-sentinel",
    favorites: "favorites-sentinel",
    editorDraft: "editor-sentinel",
    editorRecovery: "editor-recovery-sentinel",
    reset: JSON.stringify({
      version: 1,
      generation: 0,
      writerId: "stats-reset-test",
      resetAt: "2026-08-14T12:00:00.000Z",
    }),
  };
  await page.evaluate((values) => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      generation: 2,
      revision: 4,
      writerId: "stats-reset-test",
      completed: {
        "ultra-tiny": {
          moves: 1,
          pushes: 1,
          completedAt: "2026-08-14T12:00:00.000Z",
        },
      },
      daily: {},
      activity: { "2026-08-14": ["ultra-tiny"] },
    }));
    localStorage.setItem("sokomind.experience.v1", values.experience);
    localStorage.setItem("sokomind.session.v1", values.session);
    localStorage.setItem("sokomind.optimal.v4", values.optimal);
    localStorage.setItem("sokomind.ratings.v1", values.ratings);
    localStorage.setItem("sokomind.favorites.v1", values.favorites);
    localStorage.setItem("sokomind.editor-draft.v1", values.editorDraft);
    localStorage.setItem("sokomind.editor-draft-recovery.v1", values.editorRecovery);
    localStorage.setItem("sokomind.reset.v1", values.reset);
    sessionStorage.setItem("sokomind:timer", "timer-sentinel");
    sessionStorage.setItem("sokomind:timer:ultra-tiny", "room-timer-sentinel");
  }, preserved);
  await page.goto("./#/stats");

  await expect(page.getByRole("heading", { name: "Statistics" })).toBeVisible();
  await page.getByRole("button", { name: "Reset all progress" }).click();
  await page.getByRole("button", { name: "I understand, continue" }).click();
  await page.getByRole("textbox").fill("RESET");
  await page.getByRole("button", { name: "Permanently reset progress" }).click();
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();

  const actual = await page.evaluate(() => {
    const progress = JSON.parse(localStorage.getItem("sokomind.progress.v1") ?? "null") as {
      generation?: number;
      completed?: Record<string, unknown>;
      daily?: Record<string, unknown>;
      activity?: Record<string, unknown>;
    } | null;
    return {
      progress,
      experience: localStorage.getItem("sokomind.experience.v1"),
      session: localStorage.getItem("sokomind.session.v1"),
      optimal: localStorage.getItem("sokomind.optimal.v4"),
      ratings: localStorage.getItem("sokomind.ratings.v1"),
      favorites: localStorage.getItem("sokomind.favorites.v1"),
      editorDraft: localStorage.getItem("sokomind.editor-draft.v1"),
      editorRecovery: localStorage.getItem("sokomind.editor-draft-recovery.v1"),
      reset: localStorage.getItem("sokomind.reset.v1"),
      timer: sessionStorage.getItem("sokomind:timer"),
      roomTimer: sessionStorage.getItem("sokomind:timer:ultra-tiny"),
    };
  });
  assertProgressReset(actual.progress);
  expect({ ...actual, progress: undefined }).toEqual({
    progress: undefined,
    ...preserved,
    timer: "timer-sentinel",
    roomTimer: "room-timer-sentinel",
  });
});

function assertProgressReset(progress: {
  generation?: number;
  completed?: Record<string, unknown>;
  daily?: Record<string, unknown>;
  activity?: Record<string, unknown>;
} | null): void {
  expect(progress?.generation).toBe(3);
  expect(progress?.completed).toEqual({});
  expect(progress?.daily).toEqual({});
  expect(progress?.activity).toEqual({});
}
