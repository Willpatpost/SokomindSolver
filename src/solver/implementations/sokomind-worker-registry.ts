import type { EngineCommand } from "./sokomind-engine/engine-protocol.ts";

export interface WorkerMemoryBreakdown {
  readonly runtimeBytes: number;
  readonly boardBytes: number;
  readonly retainedBytes: number;
  readonly frontierBytes: number;
  readonly cacheBytes: number;
  readonly arenaBytes: number;
  readonly recordBytes: number;
  readonly isolateSampleBytes: number;
}

export interface WorkerTelemetry {
  readonly label: string;
  readonly mode: EngineCommand["mode"];
  active: boolean;
  visited: number;
  generated: number;
  generatedForLimit: number;
  frontier: number;
  peakFrontier: number;
  retained: number;
  peakRetained: number;
  publishedRecords: number;
  estimatedMemoryBytes: number;
  peakEstimatedMemoryBytes: number;
  processMemoryBytes: number;
  peakProcessMemoryBytes: number;
  memoryBreakdown: WorkerMemoryBreakdown;
  performance: Readonly<Record<string, unknown>>;
}

const DEFAULT_MEMORY_ESTIMATE_BYTES = 16 * 1024 * 1024;

export function emptyMemoryBreakdown(): WorkerMemoryBreakdown {
  return Object.freeze({
    runtimeBytes: DEFAULT_MEMORY_ESTIMATE_BYTES,
    boardBytes: 0,
    retainedBytes: 0,
    frontierBytes: 0,
    cacheBytes: 0,
    arenaBytes: 0,
    recordBytes: 0,
    isolateSampleBytes: 0,
  });
}

export class WorkerExecutionRegistry {
  private readonly telemetry = new Map<string, WorkerTelemetry>();
  private readonly usedIds = new Set<string>();

  uniqueId(base: string): string {
    if (!this.usedIds.has(base)) {
      this.usedIds.add(base);
      return base;
    }
    let counter = 1;
    while (this.usedIds.has(`${base}-${counter}`)) counter++;
    const unique = `${base}-${counter}`;
    this.usedIds.add(unique);
    return unique;
  }

  register(
    id: string,
    label: string,
    mode: EngineCommand["mode"],
  ): WorkerTelemetry {
    const entry: WorkerTelemetry = {
      label,
      mode,
      active: true,
      visited: 0,
      generated: 0,
      generatedForLimit: 0,
      frontier: 0,
      peakFrontier: 0,
      retained: 0,
      peakRetained: 0,
      publishedRecords: 0,
      estimatedMemoryBytes: DEFAULT_MEMORY_ESTIMATE_BYTES,
      peakEstimatedMemoryBytes: DEFAULT_MEMORY_ESTIMATE_BYTES,
      processMemoryBytes: 0,
      peakProcessMemoryBytes: 0,
      memoryBreakdown: emptyMemoryBreakdown(),
      performance: Object.freeze({}),
    };
    this.telemetry.set(id, entry);
    return entry;
  }

  deactivate(id: string): void {
    const entry = this.telemetry.get(id);
    if (entry) {
      entry.active = false;
      entry.frontier = 0;
    }
  }

  get(id: string): WorkerTelemetry | undefined {
    return this.telemetry.get(id);
  }

  entries(): IterableIterator<[string, WorkerTelemetry]> {
    return this.telemetry.entries();
  }

  has(id: string): boolean {
    return this.telemetry.has(id);
  }

  get size(): number {
    return this.telemetry.size;
  }

  activeCount(): number {
    let count = 0;
    for (const t of this.telemetry.values()) {
      if (t.active) count++;
    }
    return count;
  }
}
