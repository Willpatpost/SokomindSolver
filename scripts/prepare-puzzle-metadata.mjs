import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  PUZZLES,
  getEffectiveCollection,
} from "../src/catalog/puzzles.ts";

const outputUrl = new URL("../src/catalog/puzzle-metadata.json", import.meta.url);
const shardsUrl = new URL("../src/catalog/puzzle-shards/", import.meta.url);
const checkOnly = process.argv.includes("--check");
const shardSize = 50;
const shardName = (index) => `puzzle-shard-${String(index).padStart(3, "0")}`;
const shards = Array.from(
  { length: Math.ceil(PUZZLES.length / shardSize) },
  (_, index) => PUZZLES.slice(index * shardSize, (index + 1) * shardSize),
);
const serialized = `${JSON.stringify({
  version: 1,
  puzzles: PUZZLES.map((puzzle, index) => [
    puzzle.id,
    puzzle.title,
    puzzle.difficulty,
    puzzle.boxes,
    puzzle.rows[0]?.length ?? 0,
    puzzle.rows.length,
    getEffectiveCollection(puzzle),
    shardName(Math.floor(index / shardSize)),
  ]),
}, null, 2)}\n`;
const serializedShards = shards.map((puzzles) => `${JSON.stringify(puzzles)}\n`);

async function currentShardFiles() {
  try {
    return (await readdir(shardsUrl))
      .filter((name) => /^puzzle-shard-\d{3}\.json$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

if (checkOnly) {
  let current = "";
  try {
    current = await readFile(outputUrl, "utf8");
  } catch {
    // The actionable error below is the same for a missing or stale artifact.
  }
  if (current !== serialized) {
    throw new Error(
      "Puzzle metadata is stale. Run `npm run prepare:catalog` and commit the result.",
    );
  }

  const expectedFiles = serializedShards.map((_, index) => `${shardName(index)}.json`);
  const actualFiles = await currentShardFiles();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(
      "Puzzle board shards are stale. Run `npm run prepare:catalog` and commit the result.",
    );
  }
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const current = await readFile(new URL(expectedFiles[index], shardsUrl), "utf8");
    if (current !== serializedShards[index]) {
      throw new Error(
        `Puzzle board shard ${expectedFiles[index]} is stale. Run \`npm run prepare:catalog\`.`,
      );
    }
  }
} else {
  await mkdir(shardsUrl, { recursive: true });
  await writeFile(outputUrl, serialized);
  const expectedFiles = serializedShards.map((_, index) => `${shardName(index)}.json`);
  for (let index = 0; index < expectedFiles.length; index += 1) {
    await writeFile(new URL(expectedFiles[index], shardsUrl), serializedShards[index]);
  }
  for (const staleFile of await currentShardFiles()) {
    if (!expectedFiles.includes(staleFile)) {
      await unlink(new URL(staleFile, shardsUrl));
    }
  }
  console.log(
    `Wrote ${PUZZLES.length} metadata records and ${shards.length} board shards to ${fileURLToPath(outputUrl)}.`,
  );
}
