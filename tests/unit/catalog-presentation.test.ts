import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogPresentation } from "../../src/features/generator/v2/catalog-presentation.ts";

test("catalog presentation describes measured story and topology", () => {
  assert.deepEqual(createCatalogPresentation({ difficulty: "advanced", family: "hub", mode: "composed",
    storyFamilies: ["ordered-packing", "gate-traffic"], ordinal: 3 }), {
    title: "Packing Order: Junction 3",
    hint: "In a tight goal area, decide which box must settle deepest before filling the entrance.",
  });
});

test("catalog presentation has a stable mode fallback", () => {
  assert.deepEqual(createCatalogPresentation({ difficulty: "beginner", family: "branch", mode: "plain", ordinal: 0 }), {
    title: "Open Route: Crossroads 1",
    hint: "Compare the available pushing lanes before choosing the first box to move.",
  });
});
