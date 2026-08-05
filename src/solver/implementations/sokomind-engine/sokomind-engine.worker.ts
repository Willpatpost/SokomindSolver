import {
  bidirectionalSide,
  search,
} from "./engine.generated.js";
import { dispatchEngineCommand } from "./engine-protocol.ts";

self.onmessage = ({ data }: MessageEvent<unknown>) => {
  const result = dispatchEngineCommand(data, {
    search,
    bidirectionalSide,
  });
  if (result) self.postMessage(result);
};
