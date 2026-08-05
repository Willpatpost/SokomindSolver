import { expect, test, type Page } from "@playwright/test";

const UPDATE_REVISION = "playwright-lifecycle";
const MISMATCHED_WORKER_REVISION = "playwright-mismatch-worker";
const MISMATCHED_MANIFEST_REVISION = "playwright-mismatch-manifest";
const MISMATCHED_SHELL_REVISION = "playwright-mismatch-shell";

function cachePrefixForScope(scope: string): string {
  return `sokomind-shell-${encodeURIComponent(new URL(scope).pathname)}-`;
}

async function cachePrefixForPage(page: Page): Promise<string> {
  const scope = await page.evaluate(async () =>
    (await navigator.serviceWorker.ready).scope);
  return cachePrefixForScope(scope);
}

async function waitForServiceWorkerControl(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null),
    )
    .not.toBeNull();
}

test("an online navigation 404 cannot poison the offline app shell", async ({
  context,
  page,
}) => {
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  await waitForServiceWorkerControl(page);
  const cachePrefix = await cachePrefixForPage(page);

  const missingResponse = await page.goto("./not-found");
  expect(missingResponse?.status()).toBe(404);
  await expect(page.locator("body")).toHaveText("Not found");

  const cachedShellStatus = await page.evaluate(async (cachePrefix) => {
    const cacheName = (await caches.keys()).find((name) =>
      name.startsWith(cachePrefix),
    );
    if (!cacheName) return null;
    const cache = await caches.open(cacheName);
    const shellUrl = new URL("./", document.baseURI).href;
    return (await cache.match(shellUrl))?.status ?? null;
  }, cachePrefix);
  expect(cachedShellStatus).toBe(200);

  await context.setOffline(true);
  try {
    const offlineResponse = await page.goto("./");
    expect(offlineResponse?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("a runtime dialog chunk fills on demand and reopens offline", async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    const key = "sokomind-test-document-loads";
    const count = Number(sessionStorage.getItem(key) ?? "0") + 1;
    sessionStorage.setItem(key, String(count));
  });
  await page.goto("./#/play/ultra-tiny");
  await expect(page.getByRole("heading", { name: "First Steps" })).toBeVisible();
  await waitForServiceWorkerControl(page);
  const cachePrefix = await cachePrefixForPage(page);
  expect(await page.evaluate(() =>
    sessionStorage.getItem("sokomind-test-document-loads"))).toBe("1");

  const state = await page.evaluate(async (cachePrefix) => {
    const cacheName = (await caches.keys()).find((name) =>
      name.startsWith(cachePrefix));
    if (!cacheName) return null;
    const cache = await caches.open(cacheName);
    const cachedUrls = (await cache.keys()).map((request) => request.url);
    const manifest = await fetch(new URL("./asset-manifest.json", document.baseURI))
      .then((response) => response.json()) as {
        precache: string[];
        runtime: string[];
      };
    return { cachedUrls, manifest };
  }, cachePrefix);

  expect(state).not.toBeNull();
  for (const lazyPattern of [
    /ProgressDialog-/,
    /SolverDialog-/,
    /solver\.worker-/,
    /sokomind-engine\.worker-/,
  ]) {
    const runtimeAsset = state?.manifest.runtime.find((entry) =>
      lazyPattern.test(entry));
    expect(runtimeAsset).toBeTruthy();
    expect(state?.cachedUrls).not.toContain(
      new URL(runtimeAsset ?? "", page.url()).href,
    );
  }

  const loadedPuzzleShard = state?.manifest.runtime.find((entry) =>
    /puzzle-shard-000-.*\.json$/u.test(entry));
  expect(loadedPuzzleShard).toBeTruthy();
  const loadedPuzzleShardUrl = new URL(
    loadedPuzzleShard ?? "",
    page.url(),
  ).href;
  await expect
    .poll(() =>
      page.evaluate(
        async ({ cachePrefix, assetUrl }) => {
          const cacheName = (await caches.keys()).find((name) =>
            name.startsWith(cachePrefix));
          if (!cacheName) return false;
          return Boolean(await caches.open(cacheName).then((cache) =>
            cache.match(assetUrl)));
        },
        { cachePrefix, assetUrl: loadedPuzzleShardUrl },
      ),
    )
    .toBe(true);

  const progressAsset = state?.manifest.runtime.find((entry) =>
    /ProgressDialog-.*\.js$/u.test(entry));
  expect(progressAsset).toBeTruthy();
  const progressAssetUrl = new URL(progressAsset ?? "", page.url()).href;
  expect(state?.cachedUrls).not.toContain(progressAssetUrl);

  await page.getByRole("button", { name: "Open progress" }).click();
  const progressDialog = page.getByRole("dialog", { name: "Your progress" });
  await expect(progressDialog).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        async ({ cachePrefix, assetUrl }) => {
          const cacheName = (await caches.keys()).find((name) =>
            name.startsWith(cachePrefix));
          if (!cacheName) return false;
          return Boolean(await caches.open(cacheName).then((cache) =>
            cache.match(assetUrl)));
        },
        { cachePrefix, assetUrl: progressAssetUrl },
      ),
    )
    .toBe(true);
  await progressDialog.getByRole("button", { name: "Close" }).click();

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "First Steps" }),
    ).toBeVisible();
    expect(await page.evaluate(() =>
      sessionStorage.getItem("sokomind-test-document-loads"))).toBe("2");

    await page.getByRole("button", { name: "Open progress" }).click();
    await expect(
      page.getByRole("dialog", { name: "Your progress" }),
    ).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test("a worker rejects a manifest from another build and preserves the active cache", async ({
  page,
}) => {
  await page.goto("./");
  await waitForServiceWorkerControl(page);
  const cachePrefix = await cachePrefixForPage(page);
  const initialState = await page.evaluate(async (cachePrefix) => ({
    controllerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
    cacheNames: (await caches.keys())
      .filter((name) => name.startsWith(cachePrefix))
      .sort(),
  }), cachePrefix);
  expect(initialState.controllerUrl).toMatch(/\/sw\.js$/u);
  expect(initialState.cacheNames).toHaveLength(1);

  const rejectedState = await page.evaluate(
    async ({ manifestRevision, workerRevision }) => {
      const workerUrl = new URL("./sw.js", document.baseURI);
      workerUrl.searchParams.set("playwright-sw-revision", workerRevision);
      workerUrl.searchParams.set(
        "playwright-manifest-revision",
        manifestRevision,
      );
      const registration = await navigator.serviceWorker.register(workerUrl, {
        scope: "./",
        updateViaCache: "none",
      });
      const worker = registration.installing;
      if (!worker) {
        throw new Error("The mismatched worker did not start installing.");
      }
      await new Promise<void>((resolve, reject) => {
        const onStateChange = () => {
          if (worker.state === "redundant") resolve();
          if (worker.state === "installed" || worker.state === "activated") {
            reject(new Error("A worker with a mismatched manifest was accepted."));
          }
        };
        worker.addEventListener("statechange", onStateChange);
        onStateChange();
      });
      return {
        activeUrl: registration.active?.scriptURL ?? null,
        waitingUrl: registration.waiting?.scriptURL ?? null,
      };
    },
    {
      manifestRevision: MISMATCHED_MANIFEST_REVISION,
      workerRevision: MISMATCHED_WORKER_REVISION,
    },
  );

  expect(rejectedState.activeUrl).toBe(initialState.controllerUrl);
  expect(rejectedState.waitingUrl).toBeNull();
  await expect.poll(() => page.evaluate(async (cachePrefix) =>
    (await caches.keys())
      .filter((name) => name.startsWith(cachePrefix))
      .sort(), cachePrefix)).toEqual(initialState.cacheNames);
  expect(initialState.cacheNames).not.toContain(
    `${cachePrefix}${MISMATCHED_WORKER_REVISION}`,
  );
});

test("a worker rejects mixed-generation shell bytes and preserves the active cache", async ({
  page,
}) => {
  await page.goto("./");
  await waitForServiceWorkerControl(page);
  const cachePrefix = await cachePrefixForPage(page);
  const initialState = await page.evaluate(async (cachePrefix) => ({
    controllerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
    cacheNames: (await caches.keys())
      .filter((name) => name.startsWith(cachePrefix))
      .sort(),
  }), cachePrefix);
  expect(initialState.controllerUrl).toMatch(/\/sw\.js$/u);
  expect(initialState.cacheNames).toHaveLength(1);

  const rejectedState = await page.evaluate(async (workerRevision) => {
    const workerUrl = new URL("./sw.js", document.baseURI);
    workerUrl.searchParams.set("playwright-sw-revision", workerRevision);
    workerUrl.searchParams.set("playwright-shell-mismatch", "1");
    const registration = await navigator.serviceWorker.register(workerUrl, {
      scope: "./",
      updateViaCache: "none",
    });
    const worker = registration.installing;
    if (!worker) {
      throw new Error("The mixed-shell worker did not start installing.");
    }
    await new Promise<void>((resolve, reject) => {
      const onStateChange = () => {
        if (worker.state === "redundant") resolve();
        if (worker.state === "installed" || worker.state === "activated") {
          reject(new Error("A worker with mismatched shell bytes was accepted."));
        }
      };
      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    });
    return {
      activeUrl: registration.active?.scriptURL ?? null,
      waitingUrl: registration.waiting?.scriptURL ?? null,
    };
  }, MISMATCHED_SHELL_REVISION);

  expect(rejectedState.activeUrl).toBe(initialState.controllerUrl);
  expect(rejectedState.waitingUrl).toBeNull();
  await expect.poll(() => page.evaluate(async (cachePrefix) =>
    (await caches.keys())
      .filter((name) => name.startsWith(cachePrefix))
      .sort(), cachePrefix)).toEqual(initialState.cacheNames);
  expect(initialState.cacheNames).not.toContain(
    `${cachePrefix}${MISMATCHED_SHELL_REVISION}`,
  );
});

test("the update UI activates a revised worker without deleting a sibling scope cache", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const key = "sokomind-test-update-document-loads";
    const count = Number(sessionStorage.getItem(key) ?? "0") + 1;
    sessionStorage.setItem(key, String(count));
    if (count > 1) {
      // The test revision uses a query string to supply different worker bytes.
      // On the post-activation reload, avoid staging the canonical fixture as
      // an artificial third generation that cannot occur in a real deployment.
      const getRegistration = navigator.serviceWorker.getRegistration.bind(
        navigator.serviceWorker,
      );
      navigator.serviceWorker.register = async () => {
        const registration = await getRegistration();
        if (!registration) throw new Error("The revised worker registration is missing.");
        return registration;
      };
    }
  });
  await page.goto("./");
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  await waitForServiceWorkerControl(page);
  const cachePrefix = await cachePrefixForPage(page);
  const siblingScope = new URL("/sokomind-sibling/", page.url()).href;
  const siblingCachePrefix = cachePrefixForScope(siblingScope);
  const siblingCacheName = `${siblingCachePrefix}sibling-revision`;
  const legacyCacheName = "sokomind-shell-aaaaaaaaaaaaaaaa";
  expect(siblingCachePrefix).not.toBe(cachePrefix);

  const initialGeneration = await page.evaluate(async (cachePrefix) => ({
    controllerUrl: navigator.serviceWorker.controller?.scriptURL ?? null,
    cacheNames: (await caches.keys())
      .filter((name) => name.startsWith(cachePrefix))
      .sort(),
  }), cachePrefix);
  expect(initialGeneration.controllerUrl).toMatch(/\/sw\.js$/u);
  expect(initialGeneration.cacheNames).toHaveLength(1);
  expect(initialGeneration.cacheNames).not.toContain(
    `${cachePrefix}${UPDATE_REVISION}`,
  );

  await page.evaluate(
    async ({
      cachePrefix,
      legacyCacheName,
      siblingCacheName,
      siblingScope,
      updateCacheName,
    }) => {
      const obsoleteUrl = new URL("./obsolete-test-entry", document.baseURI);
      const oldCache = await caches.open(`${cachePrefix}obsolete`);
      await oldCache.put(obsoleteUrl, new Response("old"));
      const futureCache = await caches.open(updateCacheName);
      await futureCache.put(obsoleteUrl, new Response("unexpected"));
      const siblingCache = await caches.open(siblingCacheName);
      await siblingCache.put(
        new URL("sentinel", siblingScope),
        new Response("sibling-cache-survived"),
      );
      const legacyCache = await caches.open(legacyCacheName);
      await legacyCache.put(
        new URL("./legacy-current-entry", document.baseURI),
        new Response("legacy-current"),
      );
      await legacyCache.put(
        new URL("legacy-sentinel", siblingScope),
        new Response("legacy-sibling-survived"),
      );
    },
    {
      cachePrefix,
      legacyCacheName,
      siblingCacheName,
      siblingScope,
      updateCacheName: `${cachePrefix}${UPDATE_REVISION}`,
    },
  );

  await page.evaluate(async (revision) => {
    const workerUrl = new URL("./sw.js", document.baseURI);
    workerUrl.searchParams.set("playwright-sw-revision", revision);
    const registration = await navigator.serviceWorker.register(workerUrl, {
      scope: "./",
      updateViaCache: "none",
    });

    await new Promise<void>((resolve, reject) => {
      if (registration.waiting) {
        resolve();
        return;
      }
      const worker = registration.installing;
      if (!worker) {
        reject(new Error("The revised service worker did not start installing."));
        return;
      }
      worker.addEventListener("statechange", () => {
        if (worker.state === "installed") resolve();
        if (worker.state === "redundant") {
          reject(new Error("The revised service worker became redundant."));
        }
      });
    });
  }, UPDATE_REVISION);

  const reloadButton = page.getByRole("button", { name: "Reload" });
  await expect(reloadButton).toBeVisible();
  await Promise.all([
    page.waitForEvent("load"),
    reloadButton.click(),
  ]);
  await expect(page.getByRole("heading", { name: "Sokomind" })).toBeVisible();
  expect(await page.evaluate(() =>
    sessionStorage.getItem("sokomind-test-update-document-loads"))).toBe("2");

  await expect
    .poll(() =>
      page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ""),
    )
    .toContain(`playwright-sw-revision=${UPDATE_REVISION}`);

  const updatedControllerUrl = await page.evaluate(() =>
    navigator.serviceWorker.controller?.scriptURL ?? null);
  expect(updatedControllerUrl).not.toBe(initialGeneration.controllerUrl);

  await expect
    .poll(() =>
      page.evaluate(async (cachePrefix) =>
        (await caches.keys())
          .filter((name) => name.startsWith(cachePrefix))
          .sort(),
      cachePrefix),
    )
    .toEqual([`${cachePrefix}${UPDATE_REVISION}`]);

  const cacheState = await page.evaluate(async ({
    cachePrefix,
    legacyCacheName,
    siblingCacheName,
    siblingScope,
  }) => {
    const matchingNames = (await caches.keys())
      .filter((name) => name.startsWith(cachePrefix))
      .sort();
    const activeName = matchingNames[0];
    if (!activeName) {
      return {
        matchingNames,
        cachedUrls: [],
        expectedUrls: [],
        legacyCurrentBody: null,
        legacySiblingBody: null,
        siblingBody: null,
      };
    }

    const cache = await caches.open(activeName);
    const cachedUrls = (await cache.keys()).map((request) => request.url).sort();
    const manifestUrl = new URL("./asset-manifest.json", document.baseURI);
    manifestUrl.search = new URL(
      navigator.serviceWorker.controller?.scriptURL ?? document.baseURI,
    ).search;
    const assetManifest = await fetch(manifestUrl).then((response) =>
      response.json()) as { precache: string[] };
    const expectedUrls = [
      "./",
      "./favicon.svg",
      "./icon-192.png",
      "./icon-512.png",
      "./manifest.webmanifest",
      ...assetManifest.precache,
    ]
      .map((entry) => new URL(entry, document.baseURI).href)
      .concat(manifestUrl.href)
      .sort();
    const siblingBody = await caches.open(siblingCacheName)
      .then((siblingCache) => siblingCache.match(new URL("sentinel", siblingScope)))
      .then((response) => response?.text() ?? null);
    const legacyCache = await caches.open(legacyCacheName);
    const legacyCurrentBody = await legacyCache
      .match(new URL("./legacy-current-entry", document.baseURI))
      .then((response) => response?.text() ?? null);
    const legacySiblingBody = await legacyCache
      .match(new URL("legacy-sentinel", siblingScope))
      .then((response) => response?.text() ?? null);
    return {
      matchingNames,
      cachedUrls,
      expectedUrls,
      legacyCurrentBody,
      legacySiblingBody,
      siblingBody,
    };
  }, { cachePrefix, legacyCacheName, siblingCacheName, siblingScope });

  expect(cacheState.matchingNames).toEqual([
    `${cachePrefix}${UPDATE_REVISION}`,
  ]);
  expect(cacheState.cachedUrls).toEqual(cacheState.expectedUrls);
  expect(cacheState.legacyCurrentBody).toBeNull();
  expect(cacheState.legacySiblingBody).toBe("legacy-sibling-survived");
  expect(cacheState.siblingBody).toBe("sibling-cache-survived");
});
