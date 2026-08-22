import { parentPort } from "node:worker_threads";
import {
  bidirectionalSide,
  search,
} from "./sokomind-engine/engine.generated.js";
import { dispatchEngineCommand } from "./sokomind-engine/engine-protocol.ts";

if (!parentPort) throw new Error("Must run as a worker_threads Worker");
const port = parentPort;

// The vendored engine reports intermediate records and search telemetry through
// the browser-worker `postMessage` global. worker_threads exposes only
// parentPort, so provide the same contract before any search starts.
globalThis.postMessage = ((message: unknown): void => {
  port.postMessage(message);
}) as typeof globalThis.postMessage;

port.on("message", (data: unknown) => {
  const result = dispatchEngineCommand(data, {
    search,
    bidirectionalSide,
  });
  if (result) port.postMessage(result);
});
