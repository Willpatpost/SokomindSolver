import { configurePuzzleLoader } from "./puzzle-loader.ts";

/** Configure the pure catalog loader with values supplied by Vite. */
export function configureVitePuzzleLoader(): void {
  configurePuzzleLoader({
    shardUrls: import.meta.glob<string>("./puzzle-shards/*.json", {
      eager: true,
      import: "default",
      query: "?url",
    }),
    isProd: import.meta.env.PROD,
  });
}
