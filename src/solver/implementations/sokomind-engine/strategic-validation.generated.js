/*
 * GENERATED FILE - DO NOT EDIT DIRECTLY.
 *
 * Regenerate with: npm run prepare:sokomind-solver
 *
 * Provenance:
 * - baseline search engine: ../Sokomind/src
 * - assignment heuristic: ../Sokomind/src/heuristic.js
 * - adapter protocol: record telemetry and structural generated-state cap
 *
 * The source modules are vendored beside this file. They are concatenated
 * because the original engine is a classic-worker script family whose
 * declarations intentionally share one lexical scope.
 */
// A bounded, JSON-only contract shared by worker consumption and the TS adapter.
// All current deductions are hypothesis-scoped advice. None authorize pruning.
function validateStrategicPlanContract(plan) {
  let remaining = 120000;
  const json = (value, depth = 0) => {
    if (--remaining < 0 || depth > 16) return false;
    if (value === null || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value === "string") return value.length <= 100000;
    if (typeof value !== "object" || !["[object Object]", "[object Array]"].includes(
      Object.prototype.toString.call(value))) return false;
    return Object.values(value).every(child => json(child, depth + 1));
  };
  if (!plan || !json(plan) || plan.schemaVersion !== 2 || plan.orientation !== "canonical" ||
      typeof plan.snapshotKey !== "string" || !Array.isArray(plan.tasks) || plan.tasks.length > 128 ||
      !Array.isArray(plan.resources) || plan.resources.length > 128 ||
      !Array.isArray(plan.hypotheses) || plan.hypotheses.length !== 1 ||
      !Array.isArray(plan.candidates) || plan.candidates.length > 16 ||
      !["partial", "solved"].includes(plan.status)) return false;
  let snapshot;
  try { snapshot = JSON.parse(plan.snapshotKey); } catch { return false; }
  if (!Array.isArray(snapshot) || snapshot.length !== 3) return false;
  const [rows, robot, boxes] = snapshot;
  if (!Array.isArray(rows) || !rows.length || rows.length > 256 ||
      !rows.every(row => typeof row === "string" && row.length <= 256) ||
      !Array.isArray(boxes) || boxes.length > 128) return false;
  const cell = key => typeof key === "string" && /^\d+,\d+$/.test(key) && (() => {
    const [y, x] = key.split(",").map(Number);
    return typeof rows[y]?.[x] === "string" && rows[y][x] !== "O";
  })();
  const point = value => Array.isArray(value) && value.length === 2 &&
    value.every(Number.isSafeInteger) && cell(value.join(","));
  if (!point(robot) || !boxes.every(box => Array.isArray(box) && box.length === 2 &&
      cell(box[0]) && typeof box[1] === "string" && box[1].length > 0) ||
      new Set(boxes.map(box => box[0])).size !== boxes.length) return false;
  const cells = values => Array.isArray(values) && values.length > 0 && values.length <= 4096 &&
    values.every(cell) && new Set(values).size === values.length;
  const index = value => Number.isInteger(value) && value >= 0 && value < boxes.length;
  const predicate = value => value && cells(value.cells) &&
    (value.kind === "box-at-cells" ? index(value.boxIndex)
      : value.kind === "goal-filled" ? value.cells.length === 1 && typeof value.label === "string" && value.label.length > 0
      : value.kind === "cells-clear");
  const id = value => typeof value === "string" && value.length > 0 && value.length <= 160;
  const ids = new Set(plan.tasks.map(task => task?.id));
  if (ids.size !== plan.tasks.length || ![...ids].every(id)) return false;
  const hypothesis = plan.hypotheses[0];
  if (!hypothesis || !id(hypothesis.id) || hypothesis.assumption !== "root-assignment-and-transit" ||
      !Array.isArray(hypothesis.taskIds) || hypothesis.taskIds.length !== ids.size ||
      new Set(hypothesis.taskIds).size !== ids.size || !hypothesis.taskIds.every(key => ids.has(key))) return false;
  for (const task of plan.tasks) {
    const evidence = task.evidence;
    if (!["release", "export", "stage", "commit-goal"].includes(task.kind) || !index(task.boxIndex) ||
        (task.completesWhen?.kind === "box-at-cells" ? task.completesWhen.boxIndex !== task.boxIndex
          : task.kind !== "commit-goal" || task.completesWhen?.kind !== "goal-filled") ||
        (task.boxCandidates !== undefined && (!Array.isArray(task.boxCandidates) || task.boxCandidates.length > 128 ||
          !task.boxCandidates.length || !task.boxCandidates.includes(task.boxIndex) ||
          !task.boxCandidates.every(candidate => index(candidate) && boxes[candidate][1] === boxes[task.boxIndex][1]) ||
          new Set(task.boxCandidates).size !== task.boxCandidates.length)) ||
        !predicate(task.completesWhen) ||
        (task.completesWhen.kind === "goal-filled" && task.completesWhen.label !== boxes[task.boxIndex][1]) ||
        !Array.isArray(task.requires) || task.requires.length > 16 ||
        !task.requires.every(predicate) || !Array.isArray(task.dependsOn) || task.dependsOn.length > 128 ||
        !task.dependsOn.every(key => ids.has(key) && key !== task.id) ||
        (task.forTaskId !== undefined && (!ids.has(task.forTaskId) || task.forTaskId === task.id)) ||
        !evidence || evidence.strength !== "heuristic" || evidence.scope !== "hypothesis" ||
        evidence.hypothesisId !== hypothesis.id || evidence.snapshotKey !== plan.snapshotKey ||
        !id(evidence.rule) || !Array.isArray(evidence.sourceIds) || evidence.sourceIds.length > 128 ||
        !evidence.sourceIds.every(key => ids.has(key))) return false;
  }
  const byId = new Map(plan.tasks.map(task => [task.id, task]));
  const active = new Set(), done = new Set();
  const visit = key => {
    if (active.has(key)) return false;
    if (done.has(key)) return true;
    active.add(key);
    const task = byId.get(key);
    if (![...task.dependsOn, ...(task.forTaskId ? [task.forTaskId] : [])].every(visit)) return false;
    active.delete(key); done.add(key); return true;
  };
  if (![...ids].every(visit)) return false;
  if (new Set(plan.resources.map(resource => resource?.id)).size !== plan.resources.length ||
      !plan.resources.every(resource => resource && id(resource.id) && cells(resource.cells) &&
        ids.has(resource.consumerTaskId) && (resource.alternatives === undefined ||
          (Array.isArray(resource.alternatives) && resource.alternatives.length > 0 &&
            resource.alternatives.length <= 4 && resource.alternatives.every(route => cells(route) &&
              route.length === 2 && route.every(cell => resource.cells.includes(cell))))) && resource.availableFrom === "task-enabled" &&
        resource.availableUntil === "task-complete")) return false;
  if (!plan.options || Array.isArray(plan.options) || typeof plan.options !== "object" ||
      !Object.values(plan.options).every(value => typeof value === "number" && value >= 0) ||
      !plan.statistics || Array.isArray(plan.statistics) || typeof plan.statistics !== "object" ||
      !Object.values(plan.statistics).every(value => typeof value === "boolean" ||
        (typeof value === "number" && value >= 0))) return false;
  return plan.candidates.every(candidate => candidate && Array.isArray(candidate.path) &&
    candidate.path.length <= 4096 && candidate.path.every(move => ["Up", "Down", "Left", "Right"].includes(move)) &&
    candidate.moves === candidate.path.length && Number.isInteger(candidate.pushes) && candidate.pushes >= 0 &&
    candidate.pushes <= candidate.moves && Array.isArray(candidate.tasks) && candidate.tasks.length <= 128 &&
    candidate.tasks.every(key => ids.has(key)) && typeof candidate.solved === "boolean" &&
    typeof candidate.estimatedRemainingPushes === "number" && candidate.estimatedRemainingPushes >= 0 &&
    point(candidate.endpoint?.robot) && Array.isArray(candidate.endpoint.boxes) &&
    candidate.endpoint.boxes.length === boxes.length && candidate.endpoint.boxes.every((box, i) =>
      Array.isArray(box) && box.length === 3 && point(box.slice(0, 2)) && box[2] === boxes[i][1]));
}

export { validateStrategicPlanContract };
