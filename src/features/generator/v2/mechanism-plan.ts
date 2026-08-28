import { createRng } from "../board-template.ts";
import { rasterizeBlueprint } from "./blueprint-graph.ts";
import type {
  BlueprintParams,
  FunctionalBlueprint,
  FunctionalRoom,
  GoalCell,
  GoalStyle,
  MechanismDependencyEdge,
  MechanismEdgeType,
  MechanismEvidenceKind,
  MechanismEvidenceRequirement,
  MechanismGeometryRequirement,
  MechanismPlan,
  MechanismSpec,
  MechanismType,
  MechanismVerificationResult,
  PassageEdge,
  SolvedBlueprint,
  TopologyFamily,
} from "./blueprint-types.ts";
import type { DependencyVerificationResult } from "./dependency-verification.ts";
import {
  collectRoomFloorCells,
  chooseRobotPosition,
  findDoorways,
  selectGoals,
  type RoomFloorCell,
} from "./goal-placement.ts";
import type {
  DependencyDAG,
  DependencyNode,
  DependencyEdge,
  DependencyEdgeType,
} from "./dependency-graph.ts";
import type { GridPosition } from "../generator-types.ts";

// ---------------------------------------------------------------------------
// Mechanism Catalog
// ---------------------------------------------------------------------------

export interface MechanismCatalogEntry {
  readonly type: MechanismType;
  readonly minBoxes: number;
  readonly maxUsefulBoxes: number;
  readonly scalable: boolean;
  readonly minRooms: number;
  readonly needsNarrowPassage: boolean;
  readonly needsTerminalRoom: boolean;
  readonly needsLargeRoom: boolean;
  readonly evidenceRequirements: MechanismEvidenceRequirement;
  readonly description: string;
}

export const MECHANISM_CATALOG: Record<MechanismType, MechanismCatalogEntry> = {
  "packing-chain": {
    type: "packing-chain",
    minBoxes: 2,
    maxUsefulBoxes: 8,
    scalable: true,
    minRooms: 1,
    needsNarrowPassage: false,
    needsTerminalRoom: true,
    needsLargeRoom: false,
    evidenceRequirements: {
      mechanismType: "packing-chain",
      requiredKinds: ["completion-order"],
      minEvidenceCount: 1,
      description: "Goals must be filled in back-to-front order within a terminal room",
    },
    description:
      "Place goals at varying depths in a terminal room so shallow boxes " +
      "block access to deeper positions, forcing back-to-front fill order",
  },
  "gatekeeper": {
    type: "gatekeeper",
    minBoxes: 2,
    maxUsefulBoxes: 6,
    scalable: true,
    minRooms: 2,
    needsNarrowPassage: true,
    needsTerminalRoom: false,
    needsLargeRoom: false,
    evidenceRequirements: {
      mechanismType: "gatekeeper",
      requiredKinds: ["access-blocked"],
      minEvidenceCount: 1,
      description: "A box on a gate goal must be moved to allow passage to inner goals",
    },
    description:
      "One goal adjacent to a narrow passage blocks transit; other goals " +
      "require passing through the guarded bottleneck",
  },
  "gate-reopening": {
    type: "gate-reopening",
    minBoxes: 3,
    maxUsefulBoxes: 6,
    scalable: true,
    minRooms: 2,
    needsNarrowPassage: true,
    needsTerminalRoom: false,
    needsLargeRoom: false,
    evidenceRequirements: {
      mechanismType: "gate-reopening",
      requiredKinds: ["reopen-gate"],
      minEvidenceCount: 1,
      description:
        "The gate box must be displaced to open the passage, then returned " +
        "to its goal after inner boxes have transited",
    },
    description:
      "Like gatekeeper but the gate box must be temporarily displaced " +
      "and later returned, requiring at least 3 boxes",
  },
  "staging-dependency": {
    type: "staging-dependency",
    minBoxes: 2,
    maxUsefulBoxes: 4,
    scalable: true,
    minRooms: 1,
    needsNarrowPassage: false,
    needsTerminalRoom: false,
    needsLargeRoom: true,
    evidenceRequirements: {
      mechanismType: "staging-dependency",
      requiredKinds: ["staging-displacement"],
      minEvidenceCount: 1,
      description: "A blocker box must be temporarily staged to allow access to a deeper goal",
    },
    description:
      "Goals where one blocks the approach path to another, requiring " +
      "temporary staging of a box to let another pass",
  },
  "corridor-traffic": {
    type: "corridor-traffic",
    minBoxes: 2,
    maxUsefulBoxes: 6,
    scalable: true,
    minRooms: 2,
    needsNarrowPassage: true,
    needsTerminalRoom: false,
    needsLargeRoom: false,
    evidenceRequirements: {
      mechanismType: "corridor-traffic",
      requiredKinds: ["shared-passage"],
      minEvidenceCount: 1,
      description: "Multiple boxes must transit through the same narrow passage in sequence",
    },
    description:
      "Goals split across rooms connected by a narrow passage, forcing " +
      "sequential transit of boxes through the bottleneck",
  },
  "temporary-parking": {
    type: "temporary-parking",
    minBoxes: 2,
    maxUsefulBoxes: 6,
    scalable: true,
    minRooms: 1,
    needsNarrowPassage: false,
    needsTerminalRoom: false,
    needsLargeRoom: true,
    evidenceRequirements: {
      mechanismType: "temporary-parking",
      requiredKinds: ["park-and-resume"],
      minEvidenceCount: 1,
      description: "A box must be parked in a temporary location to clear a path",
    },
    description:
      "Goals in a room with enough floor space for temporary box placement " +
      "while arranging other boxes into final positions",
  },
  "dependency-chain": {
    type: "dependency-chain",
    minBoxes: 3,
    maxUsefulBoxes: 8,
    scalable: true,
    minRooms: 1,
    needsNarrowPassage: false,
    needsTerminalRoom: true,
    needsLargeRoom: false,
    evidenceRequirements: {
      mechanismType: "dependency-chain",
      requiredKinds: ["strict-chain-order"],
      minEvidenceCount: 1,
      description:
        "Three or more goals at varying depths create a sequential ordering " +
        "chain where each must be filled before the next becomes accessible",
    },
    description:
      "Three or more goals at varying depths creating sequential dependencies — " +
      "each goal blocks access to the next, forming a chain of ordering constraints",
  },
  "cross-room-exchange": {
    type: "cross-room-exchange",
    minBoxes: 2,
    maxUsefulBoxes: 4,
    scalable: true,
    minRooms: 2,
    needsNarrowPassage: true,
    needsTerminalRoom: false,
    needsLargeRoom: false,
    evidenceRequirements: {
      mechanismType: "cross-room-exchange",
      requiredKinds: ["exchange-passage"],
      minEvidenceCount: 1,
      description: "Boxes must cross between rooms through a narrow passage in opposing directions",
    },
    description:
      "Goals in different rooms requiring boxes to cross through a shared " +
      "narrow passage in opposing directions",
  },
};

// ---------------------------------------------------------------------------
// Mechanism Placement Result
// ---------------------------------------------------------------------------

export interface MechanismPlacementResult {
  readonly solved: SolvedBlueprint;
  readonly plan: MechanismPlan;
  readonly dag: DependencyDAG;
}

// ---------------------------------------------------------------------------
// Blueprint topology helpers
// ---------------------------------------------------------------------------

function hasNarrowPassage(blueprint: FunctionalBlueprint): boolean {
  return blueprint.passages.some((p) => p.width === 1);
}

function narrowPassages(blueprint: FunctionalBlueprint): readonly PassageEdge[] {
  return blueprint.passages.filter((p) => p.width === 1);
}

function terminalRooms(blueprint: FunctionalBlueprint): readonly FunctionalRoom[] {
  return blueprint.rooms.filter((r) => r.isTerminal);
}

function hasLargeRoom(blueprint: FunctionalBlueprint): boolean {
  return blueprint.rooms.some(
    (r) => (r.width >= 3 && r.height >= 2) || (r.width >= 2 && r.height >= 3),
  );
}

function largeRooms(blueprint: FunctionalBlueprint): readonly FunctionalRoom[] {
  return blueprint.rooms.filter(
    (r) => (r.width >= 3 && r.height >= 2) || (r.width >= 2 && r.height >= 3),
  );
}

// ---------------------------------------------------------------------------
// Mechanism-first geometry derivation
// ---------------------------------------------------------------------------

export function deriveGeometryRequirements(
  mechanismTypes: readonly MechanismType[],
): MechanismGeometryRequirement {
  let requiredRooms = 1;
  let requiredNarrowPassages = 0;
  let terminalRoomRequired = false;
  let largeRoomRequired = false;
  let minRoomArea = 6;

  for (const type of mechanismTypes) {
    const entry = MECHANISM_CATALOG[type];
    requiredRooms = Math.max(requiredRooms, entry.minRooms);
    if (entry.needsNarrowPassage) requiredNarrowPassages = Math.max(requiredNarrowPassages, 1);
    if (entry.needsTerminalRoom) terminalRoomRequired = true;
    if (entry.needsLargeRoom) {
      largeRoomRequired = true;
      minRoomArea = Math.max(minRoomArea, 9);
    }
  }

  const preferredFamilies: TopologyFamily[] = [];
  if (terminalRoomRequired && requiredNarrowPassages > 0) {
    preferredFamilies.push("linear", "branch");
  } else if (requiredNarrowPassages > 0) {
    preferredFamilies.push("linear", "branch", "hub");
  } else if (terminalRoomRequired) {
    preferredFamilies.push("linear", "branch", "nested");
  } else {
    preferredFamilies.push("linear", "hub", "branch", "loop", "nested");
  }

  return {
    requiredRooms,
    requiredNarrowPassages,
    terminalRoomRequired,
    largeRoomRequired,
    minRoomArea,
    preferredFamilies,
  };
}

export function selectTargetMechanisms(
  tier: string,
  boxCount: number,
  seed: number,
): MechanismType[] {
  const rng = createRng(seed);

  const available = Object.values(MECHANISM_CATALOG)
    .filter((e) => boxCount >= e.minBoxes)
    .map((e) => e.type);

  if (available.length === 0) return [];

  let targetCount: number;
  switch (tier) {
    case "advanced":
      targetCount = 1 + Math.floor(rng() * 2);
      break;
    case "expert":
      targetCount = 2 + Math.floor(rng() * 2);
      break;
    case "master":
      targetCount = 2 + Math.floor(rng() * 3);
      break;
    default:
      return [];
  }

  targetCount = Math.min(targetCount, available.length);
  const selected: MechanismType[] = [];
  const remaining = [...available];

  for (let i = 0; i < targetCount && remaining.length > 0; i++) {
    let bestIdx = Math.floor(rng() * remaining.length);

    if (selected.length > 0) {
      let bestCompat = -1;
      for (let j = 0; j < remaining.length; j++) {
        const minCompat = Math.min(
          ...selected.map((s) => mechanismCompatibility(s, remaining[j])),
        );
        if (minCompat > bestCompat) {
          bestCompat = minCompat;
          bestIdx = j;
        }
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

export function constrainBlueprintParams(
  baseParams: BlueprintParams,
  requirements: MechanismGeometryRequirement,
  seed: number,
): BlueprintParams {
  const rng = createRng(seed + 7777);

  const family: TopologyFamily = requirements.preferredFamilies.length > 0
    ? requirements.preferredFamilies[Math.floor(rng() * requirements.preferredFamilies.length)]
    : baseParams.family === "random" ? "linear" : baseParams.family;

  const minRooms = Math.max(baseParams.minRooms, requirements.requiredRooms);
  const maxRooms = Math.max(baseParams.maxRooms, minRooms);

  const minRoomSize = requirements.largeRoomRequired
    ? Math.max(baseParams.minRoomSize, 3)
    : baseParams.minRoomSize;

  const maxRoomSize = Math.max(baseParams.maxRoomSize, minRoomSize);

  const passageWidths: readonly (1 | 2)[] = requirements.requiredNarrowPassages > 0
    ? [1]
    : baseParams.passageWidths ?? [1, 2];

  return {
    ...baseParams,
    seed,
    family,
    minRooms,
    maxRooms,
    minRoomSize,
    maxRoomSize,
    passageWidths,
  };
}

// ---------------------------------------------------------------------------
// 1. Feasibility Check
// ---------------------------------------------------------------------------

export function feasibleMechanisms(
  blueprint: FunctionalBlueprint,
  boxCount: number,
): MechanismType[] {
  const result: MechanismType[] = [];
  const roomCount = blueprint.rooms.length;
  const hasNarrow = hasNarrowPassage(blueprint);
  const hasTerminal = terminalRooms(blueprint).length > 0;
  const hasLarge = hasLargeRoom(blueprint);

  for (const entry of Object.values(MECHANISM_CATALOG)) {
    if (boxCount < entry.minBoxes) continue;
    if (roomCount < entry.minRooms) continue;
    if (entry.needsNarrowPassage && !hasNarrow) continue;
    if (entry.needsTerminalRoom && !hasTerminal) continue;
    if (entry.needsLargeRoom && !hasLarge) continue;
    result.push(entry.type);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 5. Mechanism Compatibility
// ---------------------------------------------------------------------------

const COMPATIBILITY_TABLE: Record<string, number> = {
  // High compatibility pairs
  "gatekeeper|packing-chain": 0.9,
  "gatekeeper|staging-dependency": 0.85,
  "gatekeeper|corridor-traffic": 0.7,
  "gatekeeper|dependency-chain": 0.8,
  "packing-chain|staging-dependency": 0.75,
  "packing-chain|corridor-traffic": 0.7,
  "packing-chain|dependency-chain": 0.6,
  "staging-dependency|temporary-parking": 0.8,
  "staging-dependency|corridor-traffic": 0.7,
  "corridor-traffic|cross-room-exchange": 0.75,
  "gatekeeper|cross-room-exchange": 0.65,
  "gatekeeper|gate-reopening": 0.3,
  "gate-reopening|packing-chain": 0.8,
  "gate-reopening|staging-dependency": 0.7,
  "gate-reopening|corridor-traffic": 0.5,
  "gate-reopening|dependency-chain": 0.7,
  "temporary-parking|corridor-traffic": 0.65,
  "temporary-parking|packing-chain": 0.6,
  "temporary-parking|dependency-chain": 0.55,
  "dependency-chain|corridor-traffic": 0.65,
  "dependency-chain|staging-dependency": 0.7,
  "dependency-chain|cross-room-exchange": 0.5,
  "cross-room-exchange|staging-dependency": 0.6,
  "cross-room-exchange|packing-chain": 0.5,
  "cross-room-exchange|temporary-parking": 0.55,
  // Self-pairs (you can stack the same mechanism in different rooms)
  "packing-chain|packing-chain": 0.4,
  "gatekeeper|gatekeeper": 0.3,
  "gate-reopening|gate-reopening": 0.2,
  "staging-dependency|staging-dependency": 0.5,
  "corridor-traffic|corridor-traffic": 0.2,
  "temporary-parking|temporary-parking": 0.5,
  "dependency-chain|dependency-chain": 0.3,
  "cross-room-exchange|cross-room-exchange": 0.2,
  // Low compatibility (conflict for same narrow passage)
  "gate-reopening|cross-room-exchange": 0.3,
  "gate-reopening|temporary-parking": 0.5,
};

export function mechanismCompatibility(a: MechanismType, b: MechanismType): number {
  const key1 = `${a}|${b}`;
  const key2 = `${b}|${a}`;
  if (COMPATIBILITY_TABLE[key1] !== undefined) return COMPATIBILITY_TABLE[key1];
  if (COMPATIBILITY_TABLE[key2] !== undefined) return COMPATIBILITY_TABLE[key2];
  // Default compatibility for unlisted pairs
  return 0.5;
}

// ---------------------------------------------------------------------------
// 3. Plan Creation
// ---------------------------------------------------------------------------

export function createMechanismPlan(
  blueprint: FunctionalBlueprint,
  tier: string,
  boxCount: number,
  seed: number,
  targetMechanisms?: readonly MechanismType[],
): MechanismPlan | null {
  const rng = createRng(seed);
  const feasible = feasibleMechanisms(blueprint, boxCount);
  if (feasible.length === 0) return null;

  let selected: MechanismType[];

  if (targetMechanisms && targetMechanisms.length > 0) {
    const feasibleSet = new Set(feasible);
    selected = targetMechanisms.filter((m) => feasibleSet.has(m));
    if (selected.length === 0) return null;
  } else {
    const targetCount = mechanismCountForTier(tier, feasible.length, rng);
    if (targetCount === 0) return null;
    selected = selectMechanisms(feasible, targetCount, blueprint, rng);
    if (selected.length === 0) return null;
  }

  const specs = buildMechanismSpecs(selected, blueprint, boxCount, rng);
  if (!specs) return null;

  const intendedDependencies = buildIntendedDependencies(specs);
  const evidenceRequirements = specs.map(
    (s) => MECHANISM_CATALOG[s.type].evidenceRequirements,
  );

  return {
    mechanisms: specs,
    intendedDependencies,
    evidenceRequirements,
    tier,
    seed,
  };
}

function mechanismCountForTier(
  tier: string,
  maxFeasible: number,
  rng: () => number,
): number {
  let min: number;
  let max: number;

  switch (tier) {
    case "tutorial":
    case "beginner":
      min = 1;
      max = 1;
      break;
    case "intermediate":
    case "advanced":
      min = 1;
      max = 2;
      break;
    case "expert":
    case "master":
      min = 2;
      max = Math.min(4, maxFeasible);
      if (maxFeasible >= 5) max = Math.min(5, maxFeasible);
      break;
    default:
      min = 1;
      max = 2;
      break;
  }

  max = Math.min(max, maxFeasible);
  min = Math.min(min, max);

  return min + Math.floor(rng() * (max - min + 1));
}

function selectMechanisms(
  feasible: MechanismType[],
  count: number,
  blueprint: FunctionalBlueprint,
  rng: () => number,
): MechanismType[] {
  if (count === 1) {
    // Weighted random pick
    const weights = feasible.map((m) => topologyScore(m, blueprint));
    return [weightedPick(feasible, weights, rng)];
  }

  // Greedy selection: pick first by topology fit, then by compatibility
  const selected: MechanismType[] = [];
  const remaining = [...feasible];

  // Pick first mechanism by topology score
  const firstWeights = remaining.map((m) => topologyScore(m, blueprint));
  const first = weightedPick(remaining, firstWeights, rng);
  selected.push(first);
  remaining.splice(remaining.indexOf(first), 1);

  while (selected.length < count && remaining.length > 0) {
    // Score each remaining mechanism by average compatibility with already-selected
    const scores = remaining.map((candidate) => {
      const compatSum = selected.reduce(
        (sum, sel) => sum + mechanismCompatibility(candidate, sel),
        0,
      );
      const avgCompat = compatSum / selected.length;
      const topoScore = topologyScore(candidate, blueprint);
      return avgCompat * 0.6 + topoScore * 0.4;
    });

    const next = weightedPick(remaining, scores, rng);
    selected.push(next);
    remaining.splice(remaining.indexOf(next), 1);
  }

  return selected;
}

function topologyScore(mechanism: MechanismType, blueprint: FunctionalBlueprint): number {
  const narrow = narrowPassages(blueprint);
  const terminals = terminalRooms(blueprint);
  const large = largeRooms(blueprint);

  let score = 1.0;

  switch (mechanism) {
    case "packing-chain":
      score += terminals.length * 0.5;
      break;
    case "gatekeeper":
      score += narrow.length * 0.5 + (blueprint.rooms.length >= 3 ? 0.5 : 0);
      break;
    case "gate-reopening":
      score += narrow.length * 0.3 + (blueprint.rooms.length >= 3 ? 0.5 : 0);
      break;
    case "staging-dependency":
      score += large.length * 0.5;
      break;
    case "corridor-traffic":
      score += narrow.length * 0.5;
      break;
    case "temporary-parking":
      score += large.length * 0.4;
      break;
    case "dependency-chain":
      score += terminals.length * 0.6 + (blueprint.rooms.length >= 2 ? 0.3 : 0);
      break;
    case "cross-room-exchange":
      score += narrow.length * 0.4 + (blueprint.rooms.length >= 3 ? 0.5 : 0);
      break;
  }

  return score;
}

function weightedPick<T>(items: T[], weights: number[], rng: () => number): T {
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];

  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ---------------------------------------------------------------------------
// Mechanism spec building
// ---------------------------------------------------------------------------

function buildMechanismSpecs(
  selected: MechanismType[],
  blueprint: FunctionalBlueprint,
  boxCount: number,
  rng: () => number,
): MechanismSpec[] | null {
  const roomAssignments = assignRoomsToMechanisms(selected, blueprint, rng);
  const catalog = MECHANISM_CATALOG;

  const allocations = allocateBudget(selected, boxCount, rng);
  if (!allocations) return null;

  return selected.map((type, idx) => ({
    type,
    primaryRoomIds: roomAssignments[idx],
    minGoals: catalog[type].minBoxes,
    allocatedGoals: allocations[idx],
    weight: 1.0,
  }));
}

function allocateBudget(
  mechanisms: MechanismType[],
  boxCount: number,
  rng: () => number,
): number[] | null {
  const catalog = MECHANISM_CATALOG;
  const allocations = mechanisms.map((m) => catalog[m].minBoxes);
  const minSum = allocations.reduce((s, n) => s + n, 0);

  if (minSum > boxCount) return null;

  let remaining = boxCount - minSum;
  if (remaining === 0) return allocations;

  const scalableIndices = mechanisms
    .map((m, i) => ({ i, entry: catalog[m] }))
    .filter((x) => x.entry.scalable && allocations[x.i] < x.entry.maxUsefulBoxes);

  if (scalableIndices.length === 0 && remaining > 0) return null;

  while (remaining > 0) {
    const eligible = scalableIndices.filter(
      (x) => allocations[x.i] < x.entry.maxUsefulBoxes,
    );
    if (eligible.length === 0) return null;

    const pick = eligible[Math.floor(rng() * eligible.length)];
    allocations[pick.i]++;
    remaining--;
  }

  return allocations;
}

function assignRoomsToMechanisms(
  mechanisms: MechanismType[],
  blueprint: FunctionalBlueprint,
  rng: () => number,
): number[][] {
  const narrow = narrowPassages(blueprint);
  const terminals = terminalRooms(blueprint);
  const large = largeRooms(blueprint);
  const usedPassages = new Set<string>();
  const assignments: number[][] = [];

  for (const mech of mechanisms) {
    switch (mech) {
      case "packing-chain":
      case "dependency-chain": {
        if (terminals.length > 0) {
          const room = pickUnused(terminals, assignments, rng);
          assignments.push([room.id]);
        } else {
          // Fallback: largest room
          const sorted = [...blueprint.rooms].sort(
            (a, b) => b.width * b.height - a.width * a.height,
          );
          assignments.push([sorted[0].id]);
        }
        break;
      }

      case "gatekeeper":
      case "gate-reopening":
      case "corridor-traffic":
      case "cross-room-exchange": {
        const passage = pickNarrowPassage(narrow, usedPassages, rng);
        if (passage) {
          usedPassages.add(`${passage.from}-${passage.to}`);
          assignments.push([passage.from, passage.to]);
        } else if (narrow.length > 0) {
          // Reuse a passage if no unused ones are available
          const p = narrow[Math.floor(rng() * narrow.length)];
          assignments.push([p.from, p.to]);
        } else {
          // Fallback: first two rooms
          const ids = blueprint.rooms.slice(0, 2).map((r) => r.id);
          assignments.push(ids);
        }
        break;
      }

      case "staging-dependency":
      case "temporary-parking": {
        if (large.length > 0) {
          const room = pickUnused(large, assignments, rng);
          assignments.push([room.id]);
        } else {
          const sorted = [...blueprint.rooms].sort(
            (a, b) => b.width * b.height - a.width * a.height,
          );
          assignments.push([sorted[0].id]);
        }
        break;
      }

      default:
        assignments.push([blueprint.rooms[0].id]);
        break;
    }
  }

  return assignments;
}

function pickUnused(
  candidates: readonly FunctionalRoom[],
  existingAssignments: number[][],
  rng: () => number,
): FunctionalRoom {
  const usedIds = new Set(existingAssignments.flat());
  const unused = candidates.filter((r) => !usedIds.has(r.id));
  if (unused.length > 0) {
    return unused[Math.floor(rng() * unused.length)];
  }
  return candidates[Math.floor(rng() * candidates.length)];
}

function pickNarrowPassage(
  passages: readonly PassageEdge[],
  used: Set<string>,
  rng: () => number,
): PassageEdge | null {
  const unused = passages.filter(
    (p) => !used.has(`${p.from}-${p.to}`) && !used.has(`${p.to}-${p.from}`),
  );
  if (unused.length > 0) {
    return unused[Math.floor(rng() * unused.length)];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Intended dependency edges between mechanisms
// ---------------------------------------------------------------------------

function buildIntendedDependencies(specs: MechanismSpec[]): MechanismDependencyEdge[] {
  const edges: MechanismDependencyEdge[] = [];

  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      const a = specs[i];
      const b = specs[j];

      // Check if mechanisms share any rooms (=> they interact)
      const sharedRooms = a.primaryRoomIds.filter((id) =>
        b.primaryRoomIds.includes(id),
      );

      if (sharedRooms.length > 0) {
        const edge = inferDependencyEdge(i, j, a, b);
        if (edge) edges.push(edge);
      }

      // Check if one mechanism's passage connects to the other's room
      const aConnectsB = a.primaryRoomIds.length >= 2 &&
        b.primaryRoomIds.some((id) => a.primaryRoomIds.includes(id));
      const bConnectsA = b.primaryRoomIds.length >= 2 &&
        a.primaryRoomIds.some((id) => b.primaryRoomIds.includes(id));

      if ((aConnectsB || bConnectsA) && sharedRooms.length === 0) {
        const connEdge = inferConnectionEdge(i, j, a, b);
        if (connEdge) edges.push(connEdge);
      }
    }
  }

  return edges;
}

function inferDependencyEdge(
  idxA: number,
  idxB: number,
  a: MechanismSpec,
  b: MechanismSpec,
): MechanismDependencyEdge | null {
  // Gatekeeper/gate-reopening blocks access to packing/chain mechanisms
  if (
    (a.type === "gatekeeper" || a.type === "gate-reopening") &&
    (b.type === "packing-chain" || b.type === "dependency-chain")
  ) {
    return {
      fromMechanism: idxA,
      toMechanism: idxB,
      edgeType: "blocks-access",
      description: `${a.type} guards passage to ${b.type} room`,
    };
  }

  if (
    (b.type === "gatekeeper" || b.type === "gate-reopening") &&
    (a.type === "packing-chain" || a.type === "dependency-chain")
  ) {
    return {
      fromMechanism: idxB,
      toMechanism: idxA,
      edgeType: "blocks-access",
      description: `${b.type} guards passage to ${a.type} room`,
    };
  }

  // Staging before packing
  if (a.type === "staging-dependency" && b.type === "packing-chain") {
    return {
      fromMechanism: idxA,
      toMechanism: idxB,
      edgeType: "must-stage",
      description: `${a.type} staging must be resolved before ${b.type} packing`,
    };
  }

  if (b.type === "staging-dependency" && a.type === "packing-chain") {
    return {
      fromMechanism: idxB,
      toMechanism: idxA,
      edgeType: "must-stage",
      description: `${b.type} staging must be resolved before ${a.type} packing`,
    };
  }

  return null;
}

function inferConnectionEdge(
  idxA: number,
  idxB: number,
  a: MechanismSpec,
  b: MechanismSpec,
): MechanismDependencyEdge | null {
  // Corridor-traffic + cross-room-exchange share passage
  if (
    (a.type === "corridor-traffic" || a.type === "cross-room-exchange") &&
    (b.type === "corridor-traffic" || b.type === "cross-room-exchange")
  ) {
    return {
      fromMechanism: idxA,
      toMechanism: idxB,
      edgeType: "shares-passage",
      description: `${a.type} and ${b.type} share a narrow passage`,
    };
  }

  // Gate mechanisms interacting with traffic
  if (
    (a.type === "gatekeeper" || a.type === "gate-reopening") &&
    (b.type === "corridor-traffic" || b.type === "cross-room-exchange")
  ) {
    return {
      fromMechanism: idxA,
      toMechanism: idxB,
      edgeType: "blocks-access",
      description: `${a.type} gate blocks passage used by ${b.type}`,
    };
  }

  if (
    (b.type === "gatekeeper" || b.type === "gate-reopening") &&
    (a.type === "corridor-traffic" || a.type === "cross-room-exchange")
  ) {
    return {
      fromMechanism: idxB,
      toMechanism: idxA,
      edgeType: "blocks-access",
      description: `${b.type} gate blocks passage used by ${a.type}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// 4. Goal Placement from Plan
// ---------------------------------------------------------------------------

export function placeGoalsFromPlan(
  blueprint: FunctionalBlueprint,
  plan: MechanismPlan,
): MechanismPlacementResult | null {
  const rng = createRng(plan.seed);
  const grid = rasterizeBlueprint(blueprint);
  const roomMap = new Map<number, FunctionalRoom>();
  for (const room of blueprint.rooms) roomMap.set(room.id, room);

  const allGoals: GoalCell[] = [];
  const allNodes: DependencyNode[] = [];
  const allEdges: DependencyEdge[] = [];
  const usedCells = new Set<string>();
  let nextNodeId = 0;

  // Track which node IDs belong to which mechanism (for cross-mechanism edges)
  const mechanismNodeRanges: Array<{ start: number; end: number }> = [];

  for (let mechIdx = 0; mechIdx < plan.mechanisms.length; mechIdx++) {
    const spec = plan.mechanisms[mechIdx];
    const startNodeId = nextNodeId;

    const result = placeMechanismGoals(
      spec,
      blueprint,
      grid,
      roomMap,
      usedCells,
      nextNodeId,
      rng,
    );

    if (!result) return null;

    for (const goal of result.goals) {
      usedCells.add(`${goal.row},${goal.column}`);
    }

    allGoals.push(...result.goals);
    allNodes.push(...result.nodes);
    allEdges.push(...result.edges);
    nextNodeId = startNodeId + result.goals.length;

    mechanismNodeRanges.push({ start: startNodeId, end: nextNodeId });
  }

  const expectedGoalCount = plan.mechanisms.reduce(
    (sum, m) => sum + m.allocatedGoals,
    0,
  );
  if (allGoals.length !== expectedGoalCount) return null;

  // Add cross-mechanism dependency edges from the plan
  for (const dep of plan.intendedDependencies) {
    const fromRange = mechanismNodeRanges[dep.fromMechanism];
    const toRange = mechanismNodeRanges[dep.toMechanism];
    if (!fromRange || !toRange) continue;

    // Connect the "primary" node of the from-mechanism to the first node of the to-mechanism
    const edgeType = mapMechanismEdgeType(dep.edgeType);
    allEdges.push({
      from: fromRange.start,
      to: toRange.start,
      type: edgeType,
      description: dep.description,
    });
  }

  // Choose robot position
  const robotPos = chooseRobotPosition(blueprint, grid, allGoals, rng);
  if (!robotPos) return null;

  const solved: SolvedBlueprint = {
    blueprint,
    grid,
    goals: allGoals,
    robotPosition: robotPos,
    goalStyle: determineGoalStyle(allGoals),
  };

  const mechanismTypes = plan.mechanisms.map((m) => m.type);
  // Use mechanism type names as motif labels for the DAG
  const motifLabels = mechanismTypes as unknown as Array<
    import("./motifs.ts").MotifType
  >;

  const dag: DependencyDAG = {
    nodes: allNodes,
    edges: allEdges,
    compositionId: `mechanism-plan-${plan.seed}`,
    motifs: motifLabels,
  };

  return { solved, plan, dag };
}

function mapMechanismEdgeType(mechEdge: MechanismEdgeType): DependencyEdgeType {
  switch (mechEdge) {
    case "must-precede":
      return "must-precede";
    case "must-stage":
      return "must-stage";
    case "shares-passage":
      return "shares-passage";
    case "blocks-access":
      return "blocks-access";
    case "must-reopen":
      return "must-reopen";
    case "must-park":
      return "must-park";
    case "chain-link":
      return "chain-link";
    case "exchange-cross":
      return "exchange-cross";
  }
}

function determineGoalStyle(
  goals: readonly GoalCell[],
): GoalStyle {
  const roomIds = new Set(goals.map((g) => g.roomId));
  if (roomIds.size === 1) return "concentrated";
  if (roomIds.size >= 2) return "multi-room";
  return "mixed";
}

// ---------------------------------------------------------------------------
// Per-mechanism goal placement dispatch
// ---------------------------------------------------------------------------

interface MechanismGoalResult {
  goals: GoalCell[];
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}

function placeMechanismGoals(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
  rng: () => number,
): MechanismGoalResult | null {
  switch (spec.type) {
    case "packing-chain":
      return placePackingChain(spec, blueprint, grid, roomMap, usedCells, startNodeId);
    case "gatekeeper":
      return placeGatekeeper(spec, blueprint, grid, roomMap, usedCells, startNodeId, rng);
    case "gate-reopening":
      return placeGateReopening(spec, blueprint, grid, roomMap, usedCells, startNodeId, rng);
    case "staging-dependency":
      return placeStagingDependency(spec, blueprint, grid, roomMap, usedCells, startNodeId);
    case "corridor-traffic":
      return placeCorridorTraffic(spec, blueprint, grid, roomMap, usedCells, startNodeId, rng);
    case "temporary-parking":
      return placeTemporaryParking(spec, blueprint, grid, roomMap, usedCells, startNodeId);
    case "dependency-chain":
      return placeDependencyChain(spec, blueprint, grid, roomMap, usedCells, startNodeId);
    case "cross-room-exchange":
      return placeCrossRoomExchange(spec, blueprint, grid, roomMap, usedCells, startNodeId, rng);
  }
}

// ---------------------------------------------------------------------------
// Packing Chain: deep goals in terminal room
// ---------------------------------------------------------------------------

function placePackingChain(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
): MechanismGoalResult | null {
  const targetRoom = roomMap.get(spec.primaryRoomIds[0]);
  if (!targetRoom) return null;

  const cells = collectRoomFloorCells(targetRoom, grid, blueprint);
  const viable = cells
    .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));

  if (viable.length < spec.allocatedGoals) return null;

  viable.sort((a, b) => {
    if (b.depthFromDoorway !== a.depthFromDoorway)
      return b.depthFromDoorway - a.depthFromDoorway;
    if (a.wallAdjacent !== b.wallAdjacent) return a.wallAdjacent ? -1 : 1;
    return a.reversePullDirs - b.reversePullDirs;
  });

  const goals = selectGoals(viable, spec.allocatedGoals, targetRoom.id, grid);
  if (goals.length < spec.allocatedGoals) return null;

  const nodes: DependencyNode[] = goals.map((g, i) => ({
    id: startNodeId + i,
    goalId: g.goalId ?? `r${g.roomId}-pack-${i}`,
    goalIndex: startNodeId + i,
    roomId: g.roomId,
    role: "inner-pack",
  }));

  const edges: DependencyEdge[] = [];
  // Sort by depth descending, create chain edges
  const sorted = goals
    .map((g, i) => ({ g, nodeId: startNodeId + i }))
    .sort((a, b) => b.g.depthFromDoorway - a.g.depthFromDoorway);

  for (let i = 0; i < sorted.length - 1; i++) {
    edges.push({
      from: sorted[i].nodeId,
      to: sorted[i + 1].nodeId,
      type: "must-precede",
      description:
        `Pack goal depth=${sorted[i].g.depthFromDoorway} must be filled before ` +
        `depth=${sorted[i + 1].g.depthFromDoorway}`,
    });
  }

  return { goals, nodes, edges };
}

// ---------------------------------------------------------------------------
// Gatekeeper: 1 goal adjacent to narrow passage, others in far room
// ---------------------------------------------------------------------------

function placeGatekeeper(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
  rng: () => number,
): MechanismGoalResult | null {
  const narrow = narrowPassages(blueprint).filter((p) =>
    (spec.primaryRoomIds.includes(p.from) && spec.primaryRoomIds.includes(p.to)) ||
    spec.primaryRoomIds.includes(p.from) ||
    spec.primaryRoomIds.includes(p.to),
  );

  if (narrow.length === 0) return null;

  const shuffled = [...narrow];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomFrom = roomMap.get(passage.from);
    const roomTo = roomMap.get(passage.to);
    if (!roomFrom || !roomTo) continue;

    const nearRoom = roomFrom.distanceFromCenter <= roomTo.distanceFromCenter
      ? roomFrom
      : roomTo;
    const farRoom = nearRoom === roomFrom ? roomTo : roomFrom;

    const nearCells = collectRoomFloorCells(nearRoom, grid, blueprint);
    const farCells = collectRoomFloorCells(farRoom, grid, blueprint);

    const gateCandidates = findGateAdjacentCells(nearCells, passage, usedCells);
    if (gateCandidates.length === 0) continue;

    const innerCount = spec.allocatedGoals - 1;
    const innerViable = farCells
      .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));
    if (innerViable.length < innerCount) continue;

    const gateCell = gateCandidates[0];
    const gateGoal: GoalCell = {
      goalId: `r${nearRoom.id}-gate`,
      row: gateCell.row,
      column: gateCell.column,
      roomId: nearRoom.id,
      depthFromDoorway: gateCell.depthFromDoorway,
      reversePullDirs: gateCell.reversePullDirs,
    };

    innerViable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    const innerGoals = selectGoals(innerViable, innerCount, farRoom.id, grid);
    if (innerGoals.length < innerCount) continue;

    const goals: GoalCell[] = [gateGoal, ...innerGoals];

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: startNodeId + i,
      goalId: g.goalId ?? `r${g.roomId}-g${i}`,
      goalIndex: startNodeId + i,
      roomId: g.roomId,
      role: i === 0 ? "gatekeeper" : "inner",
    }));

    const edges: DependencyEdge[] = [];
    for (let i = 1; i < goals.length; i++) {
      edges.push({
        from: startNodeId,
        to: startNodeId + i,
        type: "blocks-access",
        description:
          `Gate goal at (${gateGoal.row},${gateGoal.column}) blocks passage ` +
          `to inner goal at (${goals[i].row},${goals[i].column})`,
      });
    }

    return { goals, nodes, edges };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Gate Reopening: like gatekeeper but gate must be displaced and returned
// ---------------------------------------------------------------------------

function placeGateReopening(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
  rng: () => number,
): MechanismGoalResult | null {
  // Requires at least 3 boxes: 1 gate + 2 inner
  const narrow = narrowPassages(blueprint).filter((p) =>
    spec.primaryRoomIds.includes(p.from) || spec.primaryRoomIds.includes(p.to),
  );

  if (narrow.length === 0) return null;

  const shuffled = [...narrow];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomFrom = roomMap.get(passage.from);
    const roomTo = roomMap.get(passage.to);
    if (!roomFrom || !roomTo) continue;

    const nearRoom = roomFrom.distanceFromCenter <= roomTo.distanceFromCenter
      ? roomFrom
      : roomTo;
    const farRoom = nearRoom === roomFrom ? roomTo : roomFrom;

    const nearCells = collectRoomFloorCells(nearRoom, grid, blueprint);
    const farCells = collectRoomFloorCells(farRoom, grid, blueprint);

    const gateCandidates = findGateAdjacentCells(nearCells, passage, usedCells);
    if (gateCandidates.length === 0) continue;

    const innerCount = spec.allocatedGoals - 1;
    const innerViable = farCells
      .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));
    if (innerViable.length < innerCount) continue;

    const gateCell = gateCandidates[0];
    const gateGoal: GoalCell = {
      goalId: `r${nearRoom.id}-gate-reopen`,
      row: gateCell.row,
      column: gateCell.column,
      roomId: nearRoom.id,
      depthFromDoorway: gateCell.depthFromDoorway,
      reversePullDirs: gateCell.reversePullDirs,
    };

    innerViable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    const innerGoals = selectGoals(innerViable, innerCount, farRoom.id, grid);
    if (innerGoals.length < innerCount) continue;

    const goals: GoalCell[] = [gateGoal, ...innerGoals];

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: startNodeId + i,
      goalId: g.goalId ?? `r${g.roomId}-g${i}`,
      goalIndex: startNodeId + i,
      roomId: g.roomId,
      role: i === 0 ? "gate-reopen" : "inner-beyond-gate",
    }));

    const edges: DependencyEdge[] = [];
    // Gate blocks access to all inner goals
    for (let i = 1; i < goals.length; i++) {
      edges.push({
        from: startNodeId,
        to: startNodeId + i,
        type: "must-reopen",
        description:
          `Gate-reopen goal at (${gateGoal.row},${gateGoal.column}) must be displaced ` +
          `then returned after inner goal at (${goals[i].row},${goals[i].column}) passes`,
      });
    }

    return { goals, nodes, edges };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Staging Dependency: goals where one blocks approach to another
// ---------------------------------------------------------------------------

function placeStagingDependency(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
): MechanismGoalResult | null {
  const targetRoom = roomMap.get(spec.primaryRoomIds[0]);
  if (!targetRoom) return null;

  const cells = collectRoomFloorCells(targetRoom, grid, blueprint);
  const viable = cells
    .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));

  if (viable.length < spec.allocatedGoals) return null;

  viable.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

  const deepGoal = viable[0];
  if (deepGoal.depthFromDoorway < 2) return null;

  const doorways = findDoorways(targetRoom, blueprint);
  const blockingCandidates = viable.filter((c) => {
    if (c.row === deepGoal.row && c.column === deepGoal.column) return false;
    return isOnApproachPath(c, deepGoal, doorways);
  });

  if (blockingCandidates.length === 0) return null;
  const blockerGoal = blockingCandidates[0];

  const goals: GoalCell[] = [
    {
      goalId: `r${targetRoom.id}-staging-deep`,
      row: deepGoal.row,
      column: deepGoal.column,
      roomId: targetRoom.id,
      depthFromDoorway: deepGoal.depthFromDoorway,
      reversePullDirs: deepGoal.reversePullDirs,
    },
    {
      goalId: `r${targetRoom.id}-staging-blocker`,
      row: blockerGoal.row,
      column: blockerGoal.column,
      roomId: targetRoom.id,
      depthFromDoorway: blockerGoal.depthFromDoorway,
      reversePullDirs: blockerGoal.reversePullDirs,
    },
  ];

  const placedKeys = new Set([
    `${deepGoal.row},${deepGoal.column}`,
    `${blockerGoal.row},${blockerGoal.column}`,
  ]);
  const extraNeeded = spec.allocatedGoals - 2;
  if (extraNeeded > 0) {
    const extraViable = viable.filter(
      (c) => !placedKeys.has(`${c.row},${c.column}`),
    );
    const extraGoals = selectGoals(extraViable, extraNeeded, targetRoom.id, grid);
    if (extraGoals.length < extraNeeded) return null;
    goals.push(...extraGoals);
  }

  const nodes: DependencyNode[] = goals.map((g, i) => ({
    id: startNodeId + i,
    goalId: g.goalId ?? `r${g.roomId}-g${i}`,
    goalIndex: startNodeId + i,
    roomId: g.roomId,
    role: i === 0 ? "staging-deep" : "staging-blocker",
  }));

  const edges: DependencyEdge[] = [
    {
      from: startNodeId,
      to: startNodeId + 1,
      type: "must-stage",
      description:
        `Deep goal at (${deepGoal.row},${deepGoal.column}) requires staging ` +
        `through blocker at (${blockerGoal.row},${blockerGoal.column})`,
    },
  ];

  return { goals, nodes, edges };
}

// ---------------------------------------------------------------------------
// Corridor Traffic: goals split across rooms connected by narrow passage
// ---------------------------------------------------------------------------

function placeCorridorTraffic(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
  rng: () => number,
): MechanismGoalResult | null {
  const narrow = narrowPassages(blueprint).filter((p) =>
    spec.primaryRoomIds.includes(p.from) || spec.primaryRoomIds.includes(p.to),
  );

  if (narrow.length === 0) return null;

  const shuffled = [...narrow];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomA = roomMap.get(passage.from);
    const roomB = roomMap.get(passage.to);
    if (!roomA || !roomB) continue;

    const cellsA = collectRoomFloorCells(roomA, grid, blueprint);
    const cellsB = collectRoomFloorCells(roomB, grid, blueprint);
    const viableA = cellsA
      .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));
    const viableB = cellsB
      .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));

    const countA = Math.max(1, Math.floor(spec.allocatedGoals / 2));
    const countB = spec.allocatedGoals - countA;

    if (viableA.length < countA || viableB.length < countB) continue;

    viableA.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    viableB.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const goalsA = selectGoals(viableA, countA, roomA.id, grid);
    if (goalsA.length < countA) continue;

    const usedKeys = new Set([...usedCells, ...goalsA.map((g) => `${g.row},${g.column}`)]);
    const filteredB = viableB.filter((c) => !usedKeys.has(`${c.row},${c.column}`));
    const goalsB = selectGoals(filteredB, countB, roomB.id, grid);
    if (goalsB.length < countB) continue;

    const goals = [...goalsA, ...goalsB];

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: startNodeId + i,
      goalId: g.goalId ?? `r${g.roomId}-traffic-${i}`,
      goalIndex: startNodeId + i,
      roomId: g.roomId,
      role: i < countA ? "traffic-near" : "traffic-far",
    }));

    const edges: DependencyEdge[] = [];
    // Cross-room goals share the passage
    for (let ai = 0; ai < countA; ai++) {
      for (let bi = countA; bi < goals.length; bi++) {
        edges.push({
          from: startNodeId + ai,
          to: startNodeId + bi,
          type: "shares-passage",
          description:
            `Goals in rooms ${roomA.id} and ${roomB.id} share ` +
            `width-1 passage — transit sequencing required`,
        });
      }
    }

    return { goals, nodes, edges };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Temporary Parking: goals in large room with staging space
// ---------------------------------------------------------------------------

function placeTemporaryParking(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
): MechanismGoalResult | null {
  const targetRoom = roomMap.get(spec.primaryRoomIds[0]);
  if (!targetRoom) return null;

  const cells = collectRoomFloorCells(targetRoom, grid, blueprint);
  const viable = cells
    .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));

  if (viable.length < spec.allocatedGoals) return null;

  const totalFloor = cells.filter((c) => !usedCells.has(`${c.row},${c.column}`)).length;
  if (totalFloor < spec.allocatedGoals + 1) return null;

  viable.sort((a, b) => {
    if (b.depthFromDoorway !== a.depthFromDoorway)
      return b.depthFromDoorway - a.depthFromDoorway;
    return a.reversePullDirs - b.reversePullDirs;
  });

  const goals = selectGoals(viable, spec.allocatedGoals, targetRoom.id, grid);
  if (goals.length < spec.allocatedGoals) return null;

  const nodes: DependencyNode[] = goals.map((g, i) => ({
    id: startNodeId + i,
    goalId: g.goalId ?? `r${g.roomId}-park-${i}`,
    goalIndex: startNodeId + i,
    roomId: g.roomId,
    role: i === 0 ? "parking-deep" : "parking-shallow",
  }));

  const edges: DependencyEdge[] = [];
  // Deeper goals must be approached before shallower ones can be finalized
  if (goals.length >= 2) {
    edges.push({
      from: startNodeId,
      to: startNodeId + 1,
      type: "must-park",
      description:
        `Goal at (${goals[0].row},${goals[0].column}) requires temporary parking ` +
        `of box at (${goals[1].row},${goals[1].column}) for access`,
    });
  }

  return { goals, nodes, edges };
}

// ---------------------------------------------------------------------------
// Dependency Chain: 3+ goals at varying depths with sequential ordering
// ---------------------------------------------------------------------------

function placeDependencyChain(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
): MechanismGoalResult | null {
  const targetRoom = roomMap.get(spec.primaryRoomIds[0]);
  if (!targetRoom) return null;

  const cells = collectRoomFloorCells(targetRoom, grid, blueprint);
  const viable = cells
    .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));

  const goalCount = spec.allocatedGoals;
  if (viable.length < goalCount) return null;

  viable.sort((a, b) => {
    if (b.depthFromDoorway !== a.depthFromDoorway)
      return b.depthFromDoorway - a.depthFromDoorway;
    if (a.wallAdjacent !== b.wallAdjacent) return a.wallAdjacent ? -1 : 1;
    return a.reversePullDirs - b.reversePullDirs;
  });

  const goals = selectGoals(viable, goalCount, targetRoom.id, grid);
  if (goals.length < goalCount) return null;

  // Verify depth gradient exists
  const depths = goals.map((g) => g.depthFromDoorway);
  const maxDepth = Math.max(...depths);
  const minDepth = Math.min(...depths);
  if (maxDepth - minDepth < 2 && goalCount >= 3) return null;

  const nodes: DependencyNode[] = goals.map((g, i) => ({
    id: startNodeId + i,
    goalId: g.goalId ?? `r${g.roomId}-chain-${i}`,
    goalIndex: startNodeId + i,
    roomId: g.roomId,
    role: "chain-link",
  }));

  // Create sequential chain edges sorted by depth (deepest first)
  const sorted = goals
    .map((g, i) => ({ g, nodeId: startNodeId + i }))
    .sort((a, b) => b.g.depthFromDoorway - a.g.depthFromDoorway);

  const edges: DependencyEdge[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    edges.push({
      from: sorted[i].nodeId,
      to: sorted[i + 1].nodeId,
      type: "chain-link",
      description:
        `Chain: depth=${sorted[i].g.depthFromDoorway} must be filled before ` +
        `depth=${sorted[i + 1].g.depthFromDoorway}`,
    });
  }

  return { goals, nodes, edges };
}

// ---------------------------------------------------------------------------
// Cross-Room Exchange: goals in different rooms requiring cross-passage movement
// ---------------------------------------------------------------------------

function placeCrossRoomExchange(
  spec: MechanismSpec,
  blueprint: FunctionalBlueprint,
  grid: readonly (readonly string[])[],
  roomMap: Map<number, FunctionalRoom>,
  usedCells: Set<string>,
  startNodeId: number,
  rng: () => number,
): MechanismGoalResult | null {
  const narrow = narrowPassages(blueprint).filter((p) =>
    spec.primaryRoomIds.includes(p.from) || spec.primaryRoomIds.includes(p.to),
  );

  if (narrow.length === 0) return null;

  const shuffled = [...narrow];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  for (const passage of shuffled) {
    const roomA = roomMap.get(passage.from);
    const roomB = roomMap.get(passage.to);
    if (!roomA || !roomB) continue;

    const cellsA = collectRoomFloorCells(roomA, grid, blueprint);
    const cellsB = collectRoomFloorCells(roomB, grid, blueprint);
    const viableA = cellsA
      .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));
    const viableB = cellsB
      .filter((c) => c.reversePullDirs >= 1 && !usedCells.has(`${c.row},${c.column}`));

    const countA = Math.max(1, Math.floor(spec.allocatedGoals / 2));
    const countB = spec.allocatedGoals - countA;
    if (viableA.length < countA || viableB.length < countB) continue;

    viableA.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);
    viableB.sort((a, b) => b.depthFromDoorway - a.depthFromDoorway);

    const goalsA = selectGoals(viableA, countA, roomA.id, grid);
    if (goalsA.length < countA) continue;

    const usedKeys = new Set([...usedCells, ...goalsA.map((g) => `${g.row},${g.column}`)]);
    const filteredB = viableB.filter((c) => !usedKeys.has(`${c.row},${c.column}`));
    const goalsB = selectGoals(filteredB, countB, roomB.id, grid);
    if (goalsB.length < countB) continue;

    const goals = [...goalsA, ...goalsB];

    const nodes: DependencyNode[] = goals.map((g, i) => ({
      id: startNodeId + i,
      goalId: g.goalId ?? `r${g.roomId}-exchange-${i}`,
      goalIndex: startNodeId + i,
      roomId: g.roomId,
      role: "exchange",
    }));

    const edges: DependencyEdge[] = [];
    for (let ai = 0; ai < countA; ai++) {
      for (let bi = countA; bi < goals.length; bi++) {
        edges.push({
          from: startNodeId + ai,
          to: startNodeId + bi,
          type: "exchange-cross",
          description:
            `Exchange goals in rooms ${roomA.id} and ${roomB.id} require ` +
            `cross-passage movement through width-1 passage`,
        });
      }
    }

    return { goals, nodes, edges };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function findGateAdjacentCells(
  roomCells: RoomFloorCell[],
  passage: PassageEdge,
  usedCells: Set<string>,
): RoomFloorCell[] {
  const adjacent = roomCells.filter((cell) => {
    if (cell.reversePullDirs < 1) return false;
    if (usedCells.has(`${cell.row},${cell.column}`)) return false;

    for (const pc of passage.cells) {
      const dist = Math.abs(cell.row - pc.row) + Math.abs(cell.column - pc.column);
      if (dist === 1) return true;
    }
    return false;
  });

  adjacent.sort((a, b) => a.floorNeighbors - b.floorNeighbors);
  return adjacent;
}

function isOnApproachPath(
  candidate: RoomFloorCell,
  target: RoomFloorCell,
  doorways: readonly GridPosition[],
): boolean {
  for (const door of doorways) {
    const doorToTarget =
      Math.abs(door.row - target.row) + Math.abs(door.column - target.column);
    const doorToCandidate =
      Math.abs(door.row - candidate.row) + Math.abs(door.column - candidate.column);
    const candidateToTarget =
      Math.abs(candidate.row - target.row) + Math.abs(candidate.column - target.column);

    if (doorToCandidate < doorToTarget && candidateToTarget < doorToTarget) {
      if (candidate.row === target.row || candidate.column === target.column) {
        return true;
      }
      if (doorToCandidate + candidateToTarget <= doorToTarget + 1) {
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Mechanism-level evidence verification
// ---------------------------------------------------------------------------

const MECHANISM_EVIDENCE_KINDS: ReadonlySet<string> = new Set<MechanismEvidenceKind>([
  "completion-order",
  "access-blocked",
  "staging-displacement",
  "shared-route",
  "shared-passage",
  "reopen-gate",
  "park-and-resume",
  "strict-chain-order",
  "exchange-passage",
]);

const MECHANISM_DEFINING_EDGE: Record<MechanismType, string> = {
  "packing-chain": "must-precede",
  "gatekeeper": "blocks-access",
  "gate-reopening": "must-reopen",
  "staging-dependency": "must-stage",
  "corridor-traffic": "shares-passage",
  "temporary-parking": "must-park",
  "dependency-chain": "chain-link",
  "cross-room-exchange": "exchange-cross",
};

export function verifyMechanismEvidence(
  plan: MechanismPlan,
  depResult: DependencyVerificationResult,
): readonly MechanismVerificationResult[] {
  return plan.mechanisms.map((spec, mechanismIndex) => {
    const requirement = plan.evidenceRequirements[mechanismIndex];
    if (!requirement) {
      return {
        mechanismIndex,
        type: spec.type,
        passed: false,
        requiredEvidence: [],
        observedEvidence: [],
        missingEvidence: [],
      };
    }

    const definingEdgeType = MECHANISM_DEFINING_EDGE[spec.type];

    const observedKinds = new Set<MechanismEvidenceKind>();
    for (const detail of depResult.edgeDetails) {
      if (detail.edge.type !== definingEdgeType) continue;
      if (!detail.realized) continue;
      for (const ev of detail.evidence) {
        if (MECHANISM_EVIDENCE_KINDS.has(ev.kind)) {
          observedKinds.add(ev.kind as MechanismEvidenceKind);
        }
      }
    }

    const requiredEvidence = requirement.requiredKinds;
    const observedEvidence = [...observedKinds];
    const missingEvidence = requiredEvidence.filter((k) => !observedKinds.has(k));

    const meetsMinCount = observedEvidence.length >= requirement.minEvidenceCount;
    const passed = missingEvidence.length === 0 && meetsMinCount;

    return {
      mechanismIndex,
      type: spec.type,
      passed,
      requiredEvidence,
      observedEvidence,
      missingEvidence,
    };
  });
}
