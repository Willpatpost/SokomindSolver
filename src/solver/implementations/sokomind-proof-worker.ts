import { createProofWorkerRuntime } from "./sokomind-proof-runtime.ts";

const handle = createProofWorkerRuntime((result) => self.postMessage(result));

self.onmessage = ({ data }: MessageEvent<unknown>) => handle(data);
