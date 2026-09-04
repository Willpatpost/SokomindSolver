import type { Difficulty } from "../../../core/model.ts";
import type { TopologyFamily } from "./blueprint-types.ts";
import type { ForgeGenerationMode } from "./forge-sampling.ts";
import type { StoryQualityFamily } from "./story-quality-policy.ts";

export interface CatalogPresentationInput {
  readonly difficulty: Difficulty;
  readonly family: TopologyFamily;
  readonly mode: ForgeGenerationMode;
  readonly storyFamilies?: readonly StoryQualityFamily[];
  readonly ordinal: number;
}

const TOPOLOGY_NAMES: Readonly<Record<TopologyFamily, string>> = {
  linear: "Passage",
  hub: "Junction",
  loop: "Circuit",
  branch: "Crossroads",
  nested: "Chambers",
};

const STORY_PRESENTATION: Readonly<Record<StoryQualityFamily, { readonly title: string; readonly hint: string }>> = {
  "assignment-misdirection": { title: "False Promise", hint: "The nearest matching goal may not be the first useful destination." },
  "productive-reversal": { title: "Necessary Detour", hint: "A temporary move away from a goal can create the space the final route needs." },
  "multi-room-journey": { title: "Room to Room", hint: "Plan how each box crosses the narrow connection before committing to a room." },
  "ordered-packing": { title: "Packing Order", hint: "In a tight goal area, decide which box must settle deepest before filling the entrance." },
  "gate-traffic": { title: "Changing Gate", hint: "Watch which pushes open or close the route shared by the remaining boxes." },
  "shared-support": { title: "Shared Footing", hint: "Several pushes compete for the same standing squares; preserve access until they are no longer needed." },
  "shared-transport": { title: "Common Ground", hint: "Boxes share part of the same route, so keep that transport lane clear for the later trip." },
  "causal-dependency": { title: "Chain Reaction", hint: "One box changes what is possible for another, so look for the enabling move first." },
};

const MODE_FALLBACK: Readonly<Record<ForgeGenerationMode, { readonly title: string; readonly hint: string }>> = {
  plain: { title: "Open Route", hint: "Compare the available pushing lanes before choosing the first box to move." },
  motif: { title: "Hidden Pattern", hint: "The room repeats a small pushing idea; find it before committing a box." },
  composed: { title: "Connected Plans", hint: "Solve the room as linked sections and preserve the passage between them." },
  mechanism: { title: "Moving Parts", hint: "Treat each box as part of a mechanism and identify which move enables the next." },
};

/** Create stable catalog copy from facts already measured during generation. */
export function createCatalogPresentation(input: CatalogPresentationInput): { readonly title: string; readonly hint: string } {
  const story = input.storyFamilies?.find((family) => family in STORY_PRESENTATION);
  const presentation = story ? STORY_PRESENTATION[story] : MODE_FALLBACK[input.mode];
  const ordinal = Math.max(1, Math.trunc(input.ordinal));
  return {
    title: `${presentation.title}: ${TOPOLOGY_NAMES[input.family]} ${ordinal}`,
    hint: presentation.hint,
  };
}
