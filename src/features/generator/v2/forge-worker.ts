import { parentPort, workerData } from "node:worker_threads";

import { completeCandidateFromBlueprint } from "./puzzle-forge.ts";
import type { ForgeConfig } from "./puzzle-forge.ts";

const config = workerData as ForgeConfig;

parentPort!.on("message", async (msg: { type: string; index: number; payload: unknown }) => {
  if (msg.type === "shutdown") {
    process.exit(0);
  }
  if (msg.type === "task") {
    const p = msg.payload as {
      blueprint?: unknown;
      forcedReverseState?: unknown;
    };
    const bc = p.blueprint ?? msg.payload;
    const forced = p.forcedReverseState as
      | { boxPositions: readonly { row: number; column: number }[]; robotPosition: { row: number; column: number }; depth: number }
      | undefined;
    const completion = await completeCandidateFromBlueprint(bc as Parameters<typeof completeCandidateFromBlueprint>[0], config, forced);
    parentPort!.postMessage({ type: "result", index: msg.index, result: completion });
  }
});
