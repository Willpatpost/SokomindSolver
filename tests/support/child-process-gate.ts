import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PERFORMANCE_CHILD_MODULE_ENV =
  "SOKOMIND_PERFORMANCE_CHILD_MODULE";

export interface ChildProcessGateOptions {
  readonly timeoutMs: number;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ChildProcessGateResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class ChildProcessTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Child process exceeded its ${String(timeoutMs)}ms hard timeout.`);
    this.name = "ChildProcessTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Child-process timeout must be a positive integer.");
  }
}

/**
 * Runs a process behind an operating-system-enforced deadline. Unlike a
 * node:test timeout, this can terminate code that never yields the event loop.
 */
export function runProcessWithHardTimeout(
  executable: string,
  arguments_: readonly string[],
  options: ChildProcessGateOptions,
): ChildProcessGateResult {
  assertTimeout(options.timeoutMs);
  const child = spawnSync(executable, [...arguments_], {
    encoding: "utf8",
    env: options.env ?? process.env,
    killSignal: "SIGKILL",
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  const error = child.error as NodeJS.ErrnoException | undefined;
  if (error?.code === "ETIMEDOUT") {
    throw new ChildProcessTimeoutError(options.timeoutMs);
  }
  if (error) throw error;
  if (child.status === null) {
    throw new Error(
      `Child process ended without an exit status${
        child.signal ? ` (signal ${child.signal})` : ""
      }.`,
    );
  }
  return {
    status: child.status,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

function modulePath(moduleUrl: string | URL): string {
  return fileURLToPath(moduleUrl);
}

export function isPerformanceTestChild(moduleUrl: string | URL): boolean {
  return process.env[PERFORMANCE_CHILD_MODULE_ENV] === modulePath(moduleUrl);
}

export function runPerformanceTestModule(
  moduleUrl: string | URL,
  timeoutMs: number,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessGateResult {
  const path = modulePath(moduleUrl);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...extraEnv,
    [PERFORMANCE_CHILD_MODULE_ENV]: path,
  };
  // Run the module directly instead of through `node --test`. The programmatic
  // node:test API still reports failures and sets the exit status, while the
  // solver now lives in the one process represented by this handle. A timeout
  // can therefore terminate the blocking work itself rather than only killing
  // a test-runner parent and leaving its worker process orphaned.
  Reflect.deleteProperty(env, "NODE_TEST_CONTEXT");
  const result = runProcessWithHardTimeout(
    process.execPath,
    ["--experimental-strip-types", path],
    {
      timeoutMs,
      env,
    },
  );
  if (result.status !== 0) {
    const output = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `Isolated performance test exited with status ${String(result.status)}.${
        output ? `\n${output}` : ""
      }`,
    );
  }
  return result;
}

/** Relays only benchmark JSON, avoiding nested TAP output in the parent run. */
export function relayPerformanceJson(stdout: string): void {
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.replace(/^#\s?/u, "").trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      JSON.parse(line);
      console.info(line);
    } catch {
      // Non-JSON child diagnostics remain available if the child fails.
    }
  }
}
