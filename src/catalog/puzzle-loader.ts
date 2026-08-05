import type { PuzzleDefinition } from "../core/model.ts";
import { assertValidPuzzleCatalog } from "./catalog-validation.ts";
import { SOKOMIND_ORIGINALS } from "./catalog-types.ts";
import { getPuzzleMetadataById } from "./puzzle-metadata.ts";

export type ShardUrlMap = Readonly<Record<string, string>>;

export interface PuzzleLoaderConfig {
  readonly shardUrls: ShardUrlMap;
  readonly isProd: boolean;
}

let activeConfig: PuzzleLoaderConfig | undefined;

export function configurePuzzleLoader(config: PuzzleLoaderConfig): void {
  activeConfig = config;
  shardCache.clear();
  shardRequests.clear();
}

export function resetPuzzleLoader(): void {
  activeConfig = undefined;
  shardCache.clear();
  shardRequests.clear();
}

const shardCache = new Map<string, ReadonlyMap<string, PuzzleDefinition>>();
const shardRequests = new Map<string, Promise<ReadonlyMap<string, PuzzleDefinition>>>();

function shardKey(shard: string): string {
  return `./puzzle-shards/${shard}.json`;
}

function getActiveConfig(): PuzzleLoaderConfig {
  if (!activeConfig) {
    throw new Error(
      "Puzzle loader is not configured. Configure it in the application entrypoint before loading puzzles.",
    );
  }
  return activeConfig;
}

function assertMetadataMatch(
  puzzle: PuzzleDefinition,
  shard: string,
  index: number,
): void {
  const metadata = getPuzzleMetadataById(puzzle.id);
  if (!metadata) {
    throw new Error(
      `Puzzle board shard ${shard} entry ${index} has no generated metadata: ${JSON.stringify(puzzle.id)}.`,
    );
  }

  const width = puzzle.rows[0]?.length ?? 0;
  const collection = puzzle.collection ?? SOKOMIND_ORIGINALS;
  if (
    metadata.shard !== shard ||
    metadata.title !== puzzle.title ||
    metadata.difficulty !== puzzle.difficulty ||
    metadata.boxes !== puzzle.boxes ||
    metadata.width !== width ||
    metadata.height !== puzzle.rows.length ||
    metadata.collection !== collection
  ) {
    throw new Error(
      `Puzzle board shard ${shard} entry ${index} does not match generated metadata: ${JSON.stringify(puzzle.id)}.`,
    );
  }
}

async function warmRuntimeCache(
  url: string,
  config: PuzzleLoaderConfig,
): Promise<void> {
  if (
    !config.isProd ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return;
  }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), {
        once: true,
      });
    });
  }
  await fetch(url);
}

export async function loadPuzzleById(
  puzzleId: string,
): Promise<PuzzleDefinition | undefined> {
  const metadata = getPuzzleMetadataById(puzzleId);
  if (!metadata) return undefined;
  const config = getActiveConfig();

  const key = shardKey(metadata.shard);
  let puzzleMap = shardCache.get(key);
  if (!puzzleMap) {
    const url = config.shardUrls[key];
    if (!url) throw new Error(`Missing puzzle board shard: ${metadata.shard}`);
    let request = shardRequests.get(key);
    if (!request) {
      request = (async () => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Puzzle board shard request failed: ${response.status}`);
        }
        const parsed: unknown = await response.json();
        const puzzles = assertValidPuzzleCatalog(
          parsed,
          `Puzzle board shard ${metadata.shard}`,
        );
        const map = new Map<string, PuzzleDefinition>();
        for (const [index, puzzle] of puzzles.entries()) {
          assertMetadataMatch(puzzle, metadata.shard, index);
          map.set(puzzle.id, puzzle);
        }
        return map as ReadonlyMap<string, PuzzleDefinition>;
      })();
      shardRequests.set(key, request);
    }
    try {
      puzzleMap = await request;
    } catch (error) {
      shardRequests.delete(key);
      throw error;
    }
    shardCache.set(key, puzzleMap);
    void warmRuntimeCache(url, config).catch(() => {});
  }

  const puzzle = puzzleMap.get(puzzleId);
  if (!puzzle) {
    throw new Error(
      `Puzzle board shard ${metadata.shard} is missing ${JSON.stringify(puzzleId)}.`,
    );
  }
  return puzzle;
}
