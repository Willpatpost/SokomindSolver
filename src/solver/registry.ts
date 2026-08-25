import type { SolverAdapter, SolverMetadata } from "./contracts.ts";
import { assertValidSolverMetadata } from "./validation.ts";

export class DuplicateSolverError extends Error {
  readonly solverId: string;

  constructor(solverId: string) {
    super(`A solver with id "${solverId}" is already registered.`);
    this.name = "DuplicateSolverError";
    this.solverId = solverId;
  }
}

export class SolverNotFoundError extends Error {
  readonly solverId: string;

  constructor(solverId: string) {
    super(`No solver with id "${solverId}" is registered.`);
    this.name = "SolverNotFoundError";
    this.solverId = solverId;
  }
}

export class InvalidSolverAdapterError extends TypeError {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "InvalidSolverAdapterError";
    if (cause !== undefined) this.cause = cause;
  }
}

export interface SolverRegistration {
  readonly solverId: string;
  /**
   * Removes exactly the adapter represented by this registration.
   */
  unregister(): boolean;
}

function validatedSolverMetadata(adapter: SolverAdapter): SolverMetadata {
  if (!adapter || typeof adapter !== "object") {
    throw new InvalidSolverAdapterError("Solver adapter must be an object.");
  }

  let solve: unknown;
  let metadata: unknown;
  try {
    solve = adapter.solve;
    metadata = adapter.metadata;
  } catch (error) {
    throw new InvalidSolverAdapterError(
      "Solver adapter properties could not be read.",
      error,
    );
  }

  if (typeof solve !== "function") {
    throw new InvalidSolverAdapterError(
      "Solver adapter must provide a solve function.",
    );
  }

  try {
    assertValidSolverMetadata(metadata);
  } catch (error) {
    throw new InvalidSolverAdapterError(
      error instanceof Error
        ? error.message
        : "Solver adapter metadata is invalid.",
      error,
    );
  }
  return metadata;
}

/**
 * Process-local solver discovery. The registry owns no UI and starts no
 * workers; composition roots choose which adapters to register.
 */
export class SolverRegistry {
  readonly #adapters = new Map<string, SolverAdapter>();

  constructor(adapters: Iterable<SolverAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  get size(): number {
    return this.#adapters.size;
  }

  register(adapter: SolverAdapter): SolverRegistration {
    const { id } = validatedSolverMetadata(adapter);
    if (this.#adapters.has(id)) throw new DuplicateSolverError(id);

    this.#adapters.set(id, adapter);
    let active = true;
    return {
      solverId: id,
      unregister: () => {
        if (!active || this.#adapters.get(id) !== adapter) return false;
        active = false;
        return this.#adapters.delete(id);
      },
    };
  }

  unregister(solverId: string): boolean {
    return this.#adapters.delete(solverId);
  }

  has(solverId: string): boolean {
    return this.#adapters.has(solverId);
  }

  get(solverId: string): SolverAdapter | undefined {
    return this.#adapters.get(solverId);
  }

  require(solverId: string): SolverAdapter {
    const adapter = this.get(solverId);
    if (!adapter) throw new SolverNotFoundError(solverId);
    return adapter;
  }

  requireMetadata(solverId: string): SolverMetadata {
    const metadata = validatedSolverMetadata(this.require(solverId));
    if (metadata.id !== solverId) {
      throw new InvalidSolverAdapterError(
        `Registered solver "${solverId}" now declares id "${metadata.id}".`,
      );
    }
    return metadata;
  }

  list(): readonly SolverAdapter[] {
    return Object.freeze([...this.#adapters.values()]);
  }

  listMetadata(): readonly SolverMetadata[] {
    const metadata: SolverMetadata[] = [];
    for (const [registeredId, adapter] of this.#adapters) {
      try {
        const candidate = validatedSolverMetadata(adapter);
        if (candidate.id === registeredId) metadata.push(candidate);
      } catch {
        // Discovery isolates a corrupt adapter instead of hiding healthy ones.
      }
    }
    return Object.freeze(metadata);
  }
}
