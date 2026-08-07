import { parentPort } from "node:worker_threads";
import {
  bidirectionalSide,
  search,
} from "./sokomind-engine/engine.generated.js";
import { dispatchEngineCommand } from "./sokomind-engine/engine-protocol.ts";

if (!parentPort) throw new Error("Must run as a worker_threads Worker");

parentPort.on("message", (data: unknown) => {
  const result = dispatchEngineCommand(data, {
    search,
    bidirectionalSide,
  });
  if (result) parentPort!.postMessage(result);
});
