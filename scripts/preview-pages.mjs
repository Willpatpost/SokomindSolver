import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_BASE_PATH,
  PREVIEW_HOST,
  PREVIEW_PORT,
  PREVIEW_URL,
} from "./preview-settings.mjs";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const PLAYWRIGHT_REVISION_PARAMETER = "playwright-sw-revision";
const PLAYWRIGHT_MANIFEST_REVISION_PARAMETER =
  "playwright-manifest-revision";
const PLAYWRIGHT_SHELL_MISMATCH_PARAMETER = "playwright-shell-mismatch";

const CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

function resolveRequestPath(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(url, PREVIEW_URL).pathname);
  } catch {
    return null;
  }
  if (!pathname.startsWith(PREVIEW_BASE_PATH)) return null;
  const relative = pathname.slice(PREVIEW_BASE_PATH.length) || "index.html";
  const target = path.resolve(DIST, relative);
  const insideDist = path.relative(DIST, target);
  if (insideDist.startsWith("..") || path.isAbsolute(insideDist)) return null;
  return target;
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }

  const requestUrl = new URL(request.url ?? "/", PREVIEW_URL);
  const target = resolveRequestPath(request.url ?? "/");
  if (!target) {
    response.writeHead(404).end("Not found");
    return;
  }

  try {
    const details = await stat(target);
    if (!details.isFile()) throw new Error("Not a file");

    const testRevision = requestUrl.searchParams.get(
      PLAYWRIGHT_REVISION_PARAMETER,
    );
    if (
      path.basename(target) === "sw.js" &&
      testRevision &&
      /^[a-z0-9-]{1,64}$/i.test(testRevision)
    ) {
      const worker = await readFile(target, "utf8");
      const revisedWorker = worker.replace(
        /const CACHE_REVISION = "[^"]+";/,
        `const CACHE_REVISION = "${testRevision}";`,
      );
      if (revisedWorker === worker) {
        throw new Error("Could not replace the service-worker test revision.");
      }
      const body = Buffer.from(revisedWorker);
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": body.length,
        "content-type": "text/javascript; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    if (path.basename(target) === "asset-manifest.json" && testRevision) {
      const requestedManifestRevision = requestUrl.searchParams.get(
        PLAYWRIGHT_MANIFEST_REVISION_PARAMETER,
      ) ?? testRevision;
      if (!/^[a-z0-9-]{1,64}$/i.test(requestedManifestRevision)) {
        response.writeHead(400).end("Invalid test manifest revision");
        return;
      }
      const manifest = JSON.parse(await readFile(target, "utf8"));
      const body = Buffer.from(JSON.stringify({
        ...manifest,
        revision: requestedManifestRevision,
      }, null, 2));
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": body.length,
        "content-type": "application/json; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    if (
      path.basename(target) === "index.html" &&
      requestUrl.searchParams.get(PLAYWRIGHT_SHELL_MISMATCH_PARAMETER) === "1"
    ) {
      const body = Buffer.from(
        `${await readFile(target, "utf8")}\n<!-- mismatched test shell -->\n`,
      );
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-length": body.length,
        "content-type": "text/html; charset=utf-8",
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": details.size,
      "content-type":
        CONTENT_TYPES.get(path.extname(target)) ?? "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
    } else {
      createReadStream(target).pipe(response);
    }
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(PREVIEW_PORT, PREVIEW_HOST, () => {
  console.log(`Sokomind preview: ${PREVIEW_URL}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
