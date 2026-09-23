import { parentPort } from "node:worker_threads";
import { createProofWorkerRuntime } from "./sokomind-proof-runtime.ts";

if (!parentPort) throw new Error("Must run as a worker_threads Worker");
const port = parentPort;

port.on("message", createProofWorkerRuntime((result) => port.postMessage(result)));
