const CACHE_REVISION = "__SOKOMIND_BUILD_REVISION__";
const SCOPE_URL = new URL(self.registration.scope);
const CACHE_PREFIX = `sokomind-shell-${encodeURIComponent(SCOPE_URL.pathname)}`;
const CACHE_NAME = `${CACHE_PREFIX}-${CACHE_REVISION}`;
const LEGACY_CACHE_PATTERN = /^sokomind-shell-[a-f0-9]{16}$/u;
const APP_SHELL_URL = new URL("./", SCOPE_URL).href;
const ASSET_MANIFEST_URL_VALUE = new URL("./asset-manifest.json", SCOPE_URL);
// Carry a worker query through to the paired manifest. Production registration
// has no query, while the preview harness uses one to exercise real A/B worker
// lifecycle behavior without mutating dist during a test.
ASSET_MANIFEST_URL_VALUE.search = new URL(self.location.href).search;
const ASSET_MANIFEST_URL = ASSET_MANIFEST_URL_VALUE.href;
const REQUIRED_SHELL_PATHS = [
  "./",
  "./favicon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./manifest.webmanifest",
];

function scopedUrl(path) {
  const url = new URL(path, SCOPE_URL);
  if (
    url.origin !== SCOPE_URL.origin ||
    !url.pathname.startsWith(SCOPE_URL.pathname)
  ) {
    throw new Error(`Asset manifest entry is outside the app scope: ${path}`);
  }
  return url.href;
}

function parseAssetManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 2 ||
    value.revision !== CACHE_REVISION ||
    !Array.isArray(value.shell) ||
    !Array.isArray(value.precache) ||
    !Array.isArray(value.runtime) ||
    value.shell.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof entry.path !== "string" ||
        typeof entry.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(entry.sha256),
    ) ||
    [...value.precache, ...value.runtime].some(
      (entry) => typeof entry !== "string",
    )
  ) {
    throw new Error(
      "Asset manifest must match this worker revision and contain valid shell, precache, and runtime records.",
    );
  }

  const shell = value.shell.map((entry) => ({
    url: scopedUrl(entry.path),
    sha256: entry.sha256,
  }));
  const requiredShellUrls = REQUIRED_SHELL_PATHS.map(scopedUrl);
  if (
    shell.length !== requiredShellUrls.length ||
    requiredShellUrls.some(
      (url) => !shell.some((entry) => entry.url === url),
    )
  ) {
    throw new Error("Asset manifest does not contain the exact application shell.");
  }
  const precache = value.precache.map(scopedUrl);
  const runtime = value.runtime.map(scopedUrl);
  const all = [...shell.map((entry) => entry.url), ...precache, ...runtime];
  if (new Set(all).size !== all.length) {
    throw new Error("Asset manifest paths must be unique.");
  }
  return { shell, precache, runtime };
}

async function sha256(response) {
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function populateCurrentCache() {
  const manifestResponse = await fetch(ASSET_MANIFEST_URL, { cache: "no-store" });
  if (!manifestResponse.ok) {
    throw new Error(`Asset manifest request failed: ${manifestResponse.status}`);
  }

  const assetUrls = parseAssetManifest(await manifestResponse.clone().json());
  const cache = await caches.open(CACHE_NAME);
  try {
    await cache.put(ASSET_MANIFEST_URL, manifestResponse);
    const shellDigests = new Map(
      assetUrls.shell.map((entry) => [entry.url, entry.sha256]),
    );
    const installUrls = [
      ...assetUrls.shell.map((entry) => entry.url),
      ...assetUrls.precache,
    ];
    await Promise.all(installUrls.map(async (url) => {
      // Mutable shell names must bypass the HTTP cache so a new cache revision
      // cannot combine stale HTML with the new build's hashed assets.
      const fetchUrl = new URL(url);
      fetchUrl.search = new URL(self.location.href).search;
      const response = await fetch(new Request(fetchUrl, { cache: "reload" }));
      if (!response.ok) {
        throw new Error(`Install resource request failed: ${response.status}`);
      }
      const expectedDigest = shellDigests.get(url);
      if (expectedDigest && await sha256(response.clone()) !== expectedDigest) {
        throw new Error(`Application shell digest mismatch: ${url}`);
      }
      await cache.put(url, response);
    }));
  } catch (error) {
    await caches.delete(CACHE_NAME);
    throw error;
  }
}

async function expectedCacheUrls(cache) {
  const manifestResponse = await cache.match(ASSET_MANIFEST_URL);
  if (!manifestResponse) {
    throw new Error("The cached asset manifest is missing.");
  }

  const assetUrls = parseAssetManifest(await manifestResponse.json());
  return new Set([
    ASSET_MANIFEST_URL,
    ...assetUrls.shell.map((entry) => entry.url),
    ...assetUrls.precache,
    ...assetUrls.runtime,
  ]);
}

async function pruneCurrentCache() {
  const cache = await caches.open(CACHE_NAME);
  const expectedUrls = await expectedCacheUrls(cache);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => !expectedUrls.has(request.url))
      .map((request) => cache.delete(request)),
  );
}

async function pruneLegacyCaches(cacheNames) {
  // Before cache names included the registration scope, two project sites on
  // one origin could share a cache. Remove only this registration's entries so
  // migration cannot evict a sibling application's offline data.
  await Promise.all(
    cacheNames
      .filter((cacheName) => LEGACY_CACHE_PATTERN.test(cacheName))
      .map(async (cacheName) => {
        const cache = await caches.open(cacheName);
        const requests = await cache.keys();
        await Promise.all(
          requests
            .filter((request) => {
              const url = new URL(request.url);
              return (
                url.origin === SCOPE_URL.origin &&
                url.pathname.startsWith(SCOPE_URL.pathname)
              );
            })
            .map((request) => cache.delete(request)),
        );
        if ((await cache.keys()).length === 0) {
          await caches.delete(cacheName);
        }
      }),
  );
}

async function activateCurrentCache() {
  // Validate and prune the staged generation before removing the last known-good
  // cache. A corrupt installation must not discard the active offline shell.
  await pruneCurrentCache();
  const cacheNames = await caches.keys();
  await pruneLegacyCaches(cacheNames);
  await Promise.all(
    cacheNames
      .filter(
        (cacheName) =>
          cacheName.startsWith(`${CACHE_PREFIX}-`) && cacheName !== CACHE_NAME,
      )
      .map((cacheName) => caches.delete(cacheName)),
  );
  await self.clients.claim();
}

async function respondToNavigation(request) {
  try {
    // Navigation responses never replace the install-time app shell. In
    // particular, an online 404 must remain a 404 without poisoning offline use.
    return await fetch(request);
  } catch {
    return (await caches.open(CACHE_NAME).then((cache) => cache.match(APP_SHELL_URL))) ??
      Response.error();
  }
}

async function respondToAsset(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (!response.ok || response.type !== "basic") return response;

  const expectedUrls = await expectedCacheUrls(cache);
  if (expectedUrls.has(request.url)) {
    // The response promise remains pending until this write completes, keeping
    // the fetch event alive instead of launching an untracked cache mutation.
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(populateCurrentCache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(activateCurrentCache());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (
    url.origin !== SCOPE_URL.origin ||
    !url.pathname.startsWith(SCOPE_URL.pathname)
  ) {
    return;
  }

  event.respondWith(
    request.mode === "navigate"
      ? respondToNavigation(request)
      : respondToAsset(request),
  );
});
