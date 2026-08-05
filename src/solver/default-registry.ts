import { BUILT_IN_SOLVERS } from "./implementations/index.ts";
import { SolverRegistry } from "./registry.ts";

/** Fresh registries keep tests and alternate composition roots isolated. */
export function createDefaultSolverRegistry(): SolverRegistry {
  return new SolverRegistry(BUILT_IN_SOLVERS);
}

/** Application/worker default. No UI module is imported by this composition. */
export const defaultSolverRegistry = createDefaultSolverRegistry();
