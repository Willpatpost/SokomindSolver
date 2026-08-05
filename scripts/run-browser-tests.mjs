import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PREVIEW_URL } from "./preview-settings.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PREVIEW_SCRIPT = fileURLToPath(
  new URL("./preview-pages.mjs", import.meta.url),
);
const PLAYWRIGHT_CLI = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
let previewAlreadyRunning = false;
try {
  await fetch(PREVIEW_URL, {
    cache: "no-store",
    signal: AbortSignal.timeout(750),
  });
  previewAlreadyRunning = true;
} catch {
  // A refused connection means the runner can safely own the preview port.
}

if (previewAlreadyRunning) {
  throw new Error(
    `Cannot start an isolated browser test server because ${PREVIEW_URL} is already in use.`,
  );
}

const preview = spawn(process.execPath, [PREVIEW_SCRIPT], {
  cwd: ROOT,
  stdio: "inherit",
  windowsHide: true,
});

let stopping = false;

async function stopPreview() {
  if (stopping || preview.exitCode !== null) return;
  stopping = true;
  preview.kill("SIGTERM");

  await Promise.race([
    new Promise((resolve) => preview.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (preview.exitCode === null) preview.kill("SIGKILL");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void stopPreview().finally(() => process.exit(1));
  });
}

async function waitForPreview() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (preview.exitCode !== null) {
      throw new Error("The Pages preview server exited before it was ready.");
    }
    try {
      const response = await fetch(PREVIEW_URL, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${PREVIEW_URL}`);
}

try {
  await waitForPreview();
  const runner = spawn(
    process.execPath,
    [PLAYWRIGHT_CLI, "test", ...process.argv.slice(2)],
    {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    },
  );
  const exitCode = await new Promise((resolve) =>
    runner.once("exit", (code) => resolve(code ?? 1)),
  );
  await stopPreview();
  process.exitCode = exitCode;
} catch (error) {
  await stopPreview();
  throw error;
}
