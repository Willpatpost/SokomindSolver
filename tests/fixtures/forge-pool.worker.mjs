import { parentPort, threadId } from "node:worker_threads";
parentPort.on("message", async ({ index, payload }) => {
  if (payload.mode === "exit") process.exit(0);
  if (payload.mode === "throw") throw new Error("fixture failure");
  if (payload.delay) await new Promise((resolve) => setTimeout(resolve, payload.delay));
  parentPort.postMessage({ type: "result", index: payload.mode === "bad-index" ? -1 : index,
    result: { value: payload.value, threadId } });
});
