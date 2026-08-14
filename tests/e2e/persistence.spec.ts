import { expect, test, type Page } from "@playwright/test";

async function solveFirstSteps(page: Page) {
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "First Steps" });
  await expect(async () => {
    await page.keyboard.press("ArrowDown");
    await expect(dialog).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  return dialog;
}

async function solveOnePushWonder(page: Page) {
  await expect(
    page.getByRole("heading", { name: "One Push Wonder" }),
  ).toBeVisible();
  for (const key of ["ArrowUp", "ArrowLeft", "ArrowUp", "ArrowRight"]) {
    await page.keyboard.press(key);
  }
  const dialog = page.getByRole("dialog", { name: "One Push Wonder" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function storedProgressIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const serialized = localStorage.getItem("sokomind.progress.v1");
    if (!serialized) return [];
    const value = JSON.parse(serialized) as { completed?: Record<string, unknown> };
    return Object.keys(value.completed ?? {}).sort();
  });
}

test("home and puzzle selector follow progress updates from another tab", async ({
  context,
}) => {
  const homeTab = await context.newPage();
  const selectorTab = await context.newPage();
  const writerTab = await context.newPage();
  await Promise.all([
    homeTab.goto("./"),
    selectorTab.goto("./#/puzzles"),
    writerTab.goto("./#/play/ultra-tiny"),
  ]);

  const tutorialCard = selectorTab.getByRole("button", { name: /^Tutorial/ });
  await expect(homeTab.getByText(/^0 of \d+ rooms cleared$/)).toBeVisible();
  await expect(tutorialCard).toContainText(/0 of \d+ cleared/);

  await writerTab.evaluate(() => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      generation: 0,
      revision: 1,
      writerId: "cross-tab-test",
      completed: {
        "ultra-tiny": {
          moves: 1,
          pushes: 1,
          completedAt: "2026-08-01T00:00:00.000Z",
        },
      },
    }));
  });
  await expect(homeTab.getByText(/^1 of \d+ rooms cleared$/)).toBeVisible();
  await expect(tutorialCard).toContainText(/1 of \d+ cleared/);

  await writerTab.evaluate(() => {
    localStorage.setItem("sokomind.progress.v1", JSON.stringify({
      version: 2,
      generation: 1,
      revision: 0,
      writerId: "cross-tab-reset-test",
      completed: {},
    }));
  });
  await expect(homeTab.getByText(/^0 of \d+ rooms cleared$/)).toBeVisible();
  await expect(tutorialCard).toContainText(/0 of \d+ cleared/);
});

test("two active tabs preserve independent puzzle completions", async ({
  context,
}) => {
  const firstTab = await context.newPage();
  const secondTab = await context.newPage();
  await Promise.all([
    firstTab.goto("./#/play/ultra-tiny"),
    secondTab.goto("./#/play/tutorial-push"),
  ]);
  await Promise.all([
    expect(firstTab.getByRole("heading", { name: "First Steps" })).toBeVisible(),
    expect(secondTab.getByRole("heading", { name: "One Push Wonder" })).toBeVisible(),
  ]);

  const firstCompletion = await solveFirstSteps(firstTab);
  await solveOnePushWonder(secondTab);

  await expect.poll(() => storedProgressIds(firstTab)).toEqual([
    "tutorial-push",
    "ultra-tiny",
  ]);

  await firstCompletion.getByRole("button", { name: "Study board" }).click();
  await firstTab.getByRole("button", { name: "Open progress" }).click();
  const progressDialog = firstTab.getByRole("dialog", { name: "Your progress" });
  await expect(
    progressDialog.getByLabel("Import progress backup file"),
  ).toHaveAttribute("type", "file");
  await expect(progressDialog.getByTestId("completed-count")).toHaveText("2");
});

test("a reset propagates to another tab and stale progress is not resurrected", async ({
  context,
}) => {
  const resetTab = await context.newPage();
  const staleTab = await context.newPage();
  await Promise.all([
    resetTab.goto("./#/play/ultra-tiny"),
    staleTab.goto("./#/play/tutorial-push"),
  ]);

  const completion = await solveFirstSteps(resetTab);
  await completion.getByRole("button", { name: "Study board" }).click();
  await resetTab.getByRole("button", { name: "Open progress" }).click();
  const resetDialog = resetTab.getByRole("dialog", { name: "Your progress" });
  await resetDialog.getByRole("button", { name: "Reset saved progress" }).click();
  await resetDialog.getByRole("button", { name: "Yes, reset progress" }).click();
  await expect(resetDialog.getByTestId("completed-count")).toHaveText("0");

  await staleTab.getByRole("button", { name: "Open progress" }).click();
  const staleDialog = staleTab.getByRole("dialog", { name: "Your progress" });
  await expect(staleDialog.getByTestId("completed-count")).toHaveText("0");
  await staleDialog.getByRole("button", { name: "Close" }).click();

  await solveOnePushWonder(staleTab);
  await expect.poll(() => storedProgressIds(resetTab)).toEqual([
    "tutorial-push",
  ]);
});

test("progress dialog reports failed imports and resets without changing visible progress", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    const state = { blockProgress: false };
    Object.defineProperty(window, "__progressDialogFailure", { value: state });
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key === "sokomind.progress.v1" && state.blockProgress) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
  });
  await page.goto("./#/play/ultra-tiny");
  const completion = await solveFirstSteps(page);
  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("button", { name: "Open progress" }).click();
  const dialog = page.getByRole("dialog", { name: "Your progress" });
  await expect(dialog.getByTestId("completed-count")).toHaveText("1");

  await page.evaluate(() => {
    (window as typeof window & {
      __progressDialogFailure: { blockProgress: boolean };
    }).__progressDialogFailure.blockProgress = true;
  });
  await dialog.getByRole("button", { name: "Reset saved progress" }).click();
  await dialog.getByRole("button", { name: "Yes, reset progress" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "not reset" }))
    .toBeVisible();
  await expect(dialog.getByText("Saved progress was reset.")).toHaveCount(0);
  await expect(dialog.getByTestId("completed-count")).toHaveText("1");
  await dialog.getByRole("button", { name: "Cancel" }).click();

  await dialog.getByLabel("Import progress backup file").setInputFiles({
    name: "progress.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      version: 2,
      completed: {
        "tutorial-push": {
          moves: 4,
          pushes: 1,
          completedAt: "2026-08-14T12:00:00.000Z",
        },
      },
      daily: {},
      activity: { "2026-08-14": ["tutorial-push"] },
    })),
  });
  await expect(dialog.getByRole("status").filter({ hasText: "not imported" }))
    .toBeVisible();
  await expect(dialog.getByText(/Progress imported:/u)).toHaveCount(0);
  await expect(dialog.getByTestId("completed-count")).toHaveText("1");
  await expect.poll(() => storedProgressIds(page)).toEqual(["ultra-tiny"]);
});

test("a quota failure shows one warning and a later successful retry clears it", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalSetItem = Storage.prototype.setItem;
    const state = { blockProgress: true };
    Object.defineProperty(window, "__persistenceTestState", { value: state });
    Storage.prototype.setItem = function setItem(key: string, value: string) {
      if (key === "sokomind.progress.v1" && state.blockProgress) {
        throw new DOMException("Storage quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    };
  });
  await page.goto("./#/play/ultra-tiny");

  let completion = await solveFirstSteps(page);
  const warning = page.getByTestId("persistence-warning");
  await expect(warning).toBeVisible();
  await expect(warning).toHaveCount(1);

  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  completion = await solveFirstSteps(page);
  await expect(warning).toHaveCount(1);

  await page.evaluate(() => {
    const testWindow = window as unknown as Window & {
      __persistenceTestState: { blockProgress: boolean };
    };
    testWindow.__persistenceTestState.blockProgress = false;
  });
  await completion.getByRole("button", { name: "Study board" }).click();
  await page.getByRole("button", { name: "Undo" }).click();
  await solveFirstSteps(page);

  await expect(warning).toBeHidden();
  await expect.poll(() => storedProgressIds(page)).toEqual(["ultra-tiny"]);
});

test("restores a session saved only in IndexedDB before autosaving", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sokomind", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("kv");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put({
        version: 1,
        puzzleId: "ultra-tiny",
        actionLog: "D",
        updatedAt: "2026-08-03T12:00:00.000Z",
      }, "sokomind.session.v1");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    sessionStorage.setItem("sokomind:timer:ultra-tiny", "12345");
  });

  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByTestId("moves-count")).toHaveText("1");
  await expect(page.getByTestId("elapsed-time")).toHaveText("0:12");
  await expect(page.getByText("Restored 1 saved move.")).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("sokomind.session.v1");
    return raw ? (JSON.parse(raw) as { actionLog?: string }).actionLog : null;
  })).toBe("D");
  await expect.poll(() => page.evaluate(() =>
    sessionStorage.getItem("sokomind:timer:ultra-tiny"))).toBe("12345");
});

test("navigating during a delayed IDB hydration flushes intervening moves", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sokomind", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("kv")) {
          request.result.createObjectStore("kv");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction("kv", "readwrite");
    const store = transaction.objectStore("kv");
    let holding = true;
    const keepAlive = () => {
      const request = store.get("__hydration-gate__");
      request.onsuccess = () => {
        if (holding) keepAlive();
      };
    };
    keepAlive();
    const testWindow = window as unknown as Window & {
      __releaseHydrationGate: () => void;
    };
    testWindow.__releaseHydrationGate = () => {
      holding = false;
      transaction.oncomplete = () => db.close();
    };
  });

  await page.evaluate(() => {
    window.location.hash = "#/play/ultra-tiny";
  });
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await page.getByRole("button", { name: "Move down" }).click();
  await expect(page.getByTestId("moves-count")).toHaveText("1");

  await page.evaluate(() => {
    window.location.hash = "";
  });
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const serialized = localStorage.getItem("sokomind.session.v1");
    return serialized
      ? (JSON.parse(serialized) as { actionLog?: string }).actionLog
      : null;
  })).toBe("D");

  await page.evaluate(() => {
    const testWindow = window as unknown as Window & {
      __releaseHydrationGate: () => void;
    };
    testWindow.__releaseHydrationGate();
  });
});

test("a legacy reset marker prevents stale pre-fence IDB hydration", async ({
  page,
}) => {
  await page.goto("./");
  await page.evaluate(async () => {
    localStorage.setItem("sokomind.reset.v1", JSON.stringify({
      writerId: "legacy-reset",
      resetAt: "2026-08-02T12:00:00.000Z",
    }));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sokomind", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("kv")) {
          request.result.createObjectStore("kv");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("kv", "readwrite");
      transaction.objectStore("kv").put({
        version: 1,
        puzzleId: "ultra-tiny",
        actionLog: "D",
        updatedAt: "2026-08-02T11:00:00.000Z",
      }, "sokomind.session.v1");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  });

  // A query change forces a new document so it captures the retained marker.
  await page.goto("./?legacy-reset=1#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await expect(page.getByTestId("moves-count")).toHaveText("0");
  await expect(page.getByText("Restored 1 saved move.")).toHaveCount(0);
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("sokomind", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<{ generation: unknown; actionLog: unknown }>(
      (resolve, reject) => {
        const transaction = db.transaction("kv", "readonly");
        const store = transaction.objectStore("kv");
        const fence = store.get("sokomind.idb-reset-generation.v1");
        const session = store.get("sokomind.session.v1");
        transaction.oncomplete = () => {
          resolve({
            generation: fence.result,
            actionLog: (session.result as { actionLog?: unknown } | undefined)
              ?.actionLog,
          });
          db.close();
        };
        transaction.onerror = () => reject(transaction.error);
      },
    );
    return values;
  })).toEqual({ generation: 1, actionLog: "" });
});
