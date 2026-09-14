import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {createSession} from '../../src/core/index.ts';
import {PUZZLE_BY_ID} from '../../src/catalog/puzzles.ts';
import {search} from '../../src/solver/implementations/sokomind-engine/engine.generated.js';
import {toLegacyState, solutionFromLegacyPath} from '../../src/solver/implementations/sokomind-solver.ts';
import {verifySolverSolution} from '../../src/solver/verification.ts';

const session = createSession(PUZZLE_BY_ID.huge);
const request = {board: session.board, snapshot: session.snapshot, objective: {kind: 'moves' as const}};
globalThis.postMessage = (() => {}) as typeof globalThis.postMessage;
const started = performance.now();
const result = search({algorithm: 'plan-macro-beam', state: toLegacyState(request),
  maxDepth: 460, maxVisited: 6000, transpositionLimit: 60000, planBeamWidth: 32,
  planBoxBranches: 6, maxPlanSegments: 160, planSlack: 240, sequenceMacroLimit: 24,
  sequenceMacroExplored: 48, sequenceMacroResults: 4, targetedMacroExplored: 64,
  planSolutionComparisonBudget: 0, progressIntervalMs: 5000});
const elapsedMs = performance.now() - started;
assert.ok(result.path);
const solution = solutionFromLegacyPath(request, result.path);
assert.ok(solution && verifySolverSolution(request, solution).valid);
const output = {node: process.version, elapsedMs, moves: solution.moves, pushes: solution.pushes,
  verified: true, visited: result.visited, generated: result.generated,
  retained: result.retained, peakFrontier: result.peakFrontier, performance: result.performance};
writeFileSync(new URL('./profile-discovery.json', import.meta.url), JSON.stringify(output, null, 2));
console.log(JSON.stringify({elapsedMs, moves: solution.moves, pushes: solution.pushes,
  visited: result.visited, generated: result.generated, verified: true}));
