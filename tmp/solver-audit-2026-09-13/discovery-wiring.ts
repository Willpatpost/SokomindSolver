import fs from 'node:fs';
import vm from 'node:vm';
import { benchmarkTuningFingerprint } from '../../scripts/solver-v2-benchmark-lib.ts';
import { resolveSokomindTuning, sokomindTuningPayload } from '../../src/solver/implementations/sokomind-tuning.ts';
import { PUZZLE_BY_ID } from '../../src/catalog/puzzles.ts';
import { createSession } from '../../src/core/index.ts';
import { toLegacyState } from '../../src/solver/implementations/sokomind-legacy.ts';

const wiring = [{}, {firstPushWalkWeight: 0.05}, {moveAwareDiscovery: 1}, {macroIntermediateQuota: 2}].map(requested => {
  process.env.SOKOMIND_TUNING_JSON = JSON.stringify(requested);
  const resolved = sokomindTuningPayload(resolveSokomindTuning());
  return {requested, fingerprint: benchmarkTuningFingerprint(), actual: {
    firstPushWalkWeight: resolved.firstPushWalkWeight,
    moveAwareDiscovery: resolved.moveAwareDiscovery,
    macroIntermediateQuota: resolved.macroIntermediateQuota,
  }};
});
delete process.env.SOKOMIND_TUNING_JSON;

const session = createSession(PUZZLE_BY_ID.huge);
const state = toLegacyState({board: session.board, snapshot: session.snapshot, objective: {kind: 'moves'}});
const source = fs.readFileSync('src/solver/implementations/sokomind-engine/engine.generated.js', 'utf8').replace(/export \{[^}]+\};\s*$/, '');
const context = vm.createContext({performance, postMessage() {}, auditState: state});
const macro = vm.runInContext(source + `
  (() => {
    const oldTargeted = expandTargetedPushSequence, oldUntargeted = expandPushSequences;
    const calls = {targeted: 0, untargeted: 0, quotaForwarded: [], retainedTagged: 0};
    expandTargetedPushSequence = function(...args) {
      calls.targeted++;
      calls.quotaForwarded.push(args[6].macroIntermediateQuota ?? null);
      return oldTargeted(...args);
    };
    expandPushSequences = function(...args) {
      calls.untargeted++;
      return oldUntargeted(...args);
    };
    const result = planMacroBeamSearch({state: auditState, maxPlanSegments: 1,
      planBeamWidth: 32, planBoxBranches: 6, sequenceMacroLimit: 24,
      sequenceMacroExplored: 64, targetedMacroExplored: 64, macroIntermediateQuota: 8},
      event => {
        if (event.stage === 'macro-returned') calls.retainedTagged += event.states.filter(state => state.intermediateOf !== undefined).length;
      });
    const board = parse(auditState);
    const boxes = auditState.boxes.map(([cell, label]) => [...cell.split(',').map(Number), label]);
    const tasks = assignmentDoorwayPlan(boxes, board, true).tasks;
    const tasksByBox = new Map();
    for (const task of tasks) {
      if (!tasksByBox.has(task.boxIndex)) tasksByBox.set(task.boxIndex, []);
      tasksByBox.get(task.boxIndex).push(task);
    }
    const multiRoomBoxes = [...tasksByBox].filter(([, tasks]) => tasks.length > 1).map(([boxIndex, tasks]) => ({boxIndex,
      label: boxes[boxIndex][2], position: boxes[boxIndex].slice(0, 2),
      tasks: tasks.map(task => ({direction: task.direction, roomIndex: task.roomIndex, gate: task.gate})),
      selectedByCurrentMap: tasks.at(-1).direction
    }));
    return {...calls, quotaForwarded: [...calls.quotaForwarded], visited: result.visited, generated: result.generated, multiRoomBoxes};
  })()
`, context);
const keeperWork = vm.runInContext(`
  (() => {
    const original = keeperApproachProfile;
    const work = {profiles: 0, pathArrays: 0, copiedMoveEntries: 0, maxSupportWalk: 0};
    keeperApproachProfile = function(state, board, reachable) {
      work.profiles++;
      const measured = {...reachable, get(position) {
        const path = reachable.get(position);
        work.pathArrays++;
        work.copiedMoveEntries += path.length;
        work.maxSupportWalk = Math.max(work.maxSupportWalk, path.length);
        return path;
      }};
      return original(state, board, measured);
    };
    const result = planMacroBeamSearch({state: auditState, maxPlanSegments: 1,
      planBeamWidth: 32, planBoxBranches: 6, sequenceMacroLimit: 24,
      sequenceMacroExplored: 64, targetedMacroExplored: 64,
      planMoveAwareTranspositions: true});
    return {...work, visited: result.visited, generated: result.generated};
  })()
`, context);
const tinySession = createSession(PUZZLE_BY_ID['ultra-tiny']);
context.tinyState = toLegacyState({board: tinySession.board, snapshot: tinySession.snapshot, objective: {kind: 'moves'}});
const traceFormat = vm.runInContext(`
  (() => {
    const normal = planMacroBeamSearch({state: tinyState});
    const codes = normal.path.map(move => move[0]);
    return {
      fullPath: normal.path, encodedPath: codes,
      fullValidation: validateSearchSolution({state: tinyState}, normal.path),
      encodedValidation: validateSearchSolution({state: tinyState}, codes),
      rescheduleEncoded: solutionBoxRescheduleSearch({state: tinyState, solutionPath: codes})
    };
  })()
`, context);
const report = {wiring, macro, keeperWork, traceFormat};
fs.writeFileSync('tmp/solver-audit-2026-09-13/discovery-wiring.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
