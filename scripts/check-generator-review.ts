import { readFileSync } from "node:fs";
import { checkHumanGeneratorReview } from "./lib/generator-playtest.ts";

const [catalog, decisions] = process.argv.slice(2);
if (!catalog || !decisions) throw new Error("Usage: check:generator-review <review-catalog.json> <human-review.json>");
const result = checkHumanGeneratorReview(readFileSync(catalog, "utf8"), JSON.parse(readFileSync(decisions, "utf8")));
console.log(JSON.stringify(result, null, 2));
if (!result.ready) process.exitCode = 1;
