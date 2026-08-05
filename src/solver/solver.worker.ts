import { defaultSolverRegistry } from "./default-registry.ts";
import {
  SolverWorkerHost,
  type SolverWorkerHostTransport,
} from "./worker-host.ts";

const transport = self as unknown as SolverWorkerHostTransport;
const host = new SolverWorkerHost(defaultSolverRegistry, transport);
host.start();
