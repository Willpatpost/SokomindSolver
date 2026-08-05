export interface AssignmentResult {
  readonly cost: number;
  /** Row index -> selected column index; -1 when no finite assignment exists. */
  readonly columns: readonly number[];
}

function impossibleAssignment(rowCount: number): AssignmentResult {
  return Object.freeze({
    cost: Number.POSITIVE_INFINITY,
    columns: Object.freeze(Array<number>(rowCount).fill(-1)),
  });
}

function validateCosts(
  costs: readonly (readonly number[])[],
): number {
  if (!Array.isArray(costs)) {
    throw new TypeError("Assignment costs must be an array of rows.");
  }
  if (costs.length === 0) return 0;

  const columnCount = costs[0]?.length ?? 0;
  for (const row of costs) {
    if (!Array.isArray(row) || row.length !== columnCount) {
      throw new RangeError("Assignment cost rows must have equal length.");
    }
    for (const cost of row) {
      if (
        typeof cost !== "number" ||
        Number.isNaN(cost) ||
        cost < 0 ||
        cost === Number.NEGATIVE_INFINITY
      ) {
        throw new RangeError(
          "Assignment costs must be non-negative numbers or positive infinity.",
        );
      }
    }
  }
  return columnCount;
}

/**
 * Deterministic O(rows² × columns) Hungarian minimum assignment.
 *
 * Rectangular matrices are supported when rows <= columns. Iterating columns
 * in ascending order and retaining the first equal reduced cost makes ties
 * deterministic.
 */
export function minimumAssignment(
  costs: readonly (readonly number[])[],
): AssignmentResult {
  const rowCount = costs.length;
  const columnCount = validateCosts(costs);
  if (rowCount === 0) {
    return Object.freeze({ cost: 0, columns: Object.freeze([]) });
  }
  if (columnCount === 0 || rowCount > columnCount) {
    return impossibleAssignment(rowCount);
  }
  if (costs.some((row) => row.every((cost) => !Number.isFinite(cost)))) {
    return impossibleAssignment(rowCount);
  }

  const rowPotential = new Float64Array(rowCount + 1);
  const columnPotential = new Float64Array(columnCount + 1);
  const matchedRowByColumn = new Int32Array(columnCount + 1);
  const predecessorColumn = new Int32Array(columnCount + 1);

  for (let row = 1; row <= rowCount; row += 1) {
    matchedRowByColumn[0] = row;
    const minimumReducedCost = new Float64Array(columnCount + 1);
    minimumReducedCost.fill(Number.POSITIVE_INFINITY);
    const used = new Uint8Array(columnCount + 1);
    let currentColumn = 0;

    do {
      used[currentColumn] = 1;
      const currentRow = matchedRowByColumn[currentColumn];
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;

      for (let column = 1; column <= columnCount; column += 1) {
        if (used[column]) continue;
        const reducedCost =
          costs[currentRow - 1][column - 1] -
          rowPotential[currentRow] -
          columnPotential[column];
        if (reducedCost < minimumReducedCost[column]) {
          minimumReducedCost[column] = reducedCost;
          predecessorColumn[column] = currentColumn;
        }
        if (minimumReducedCost[column] < delta) {
          delta = minimumReducedCost[column];
          nextColumn = column;
        }
      }

      if (!Number.isFinite(delta)) return impossibleAssignment(rowCount);

      for (let column = 0; column <= columnCount; column += 1) {
        if (used[column]) {
          rowPotential[matchedRowByColumn[column]] += delta;
          columnPotential[column] -= delta;
        } else {
          minimumReducedCost[column] -= delta;
        }
      }
      currentColumn = nextColumn;
    } while (matchedRowByColumn[currentColumn] !== 0);

    do {
      const previousColumn = predecessorColumn[currentColumn];
      matchedRowByColumn[currentColumn] = matchedRowByColumn[previousColumn];
      currentColumn = previousColumn;
    } while (currentColumn !== 0);
  }

  const columns = Array<number>(rowCount).fill(-1);
  for (let column = 1; column <= columnCount; column += 1) {
    const row = matchedRowByColumn[column];
    if (row > 0) columns[row - 1] = column - 1;
  }

  let cost = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const column = columns[row];
    if (column < 0 || !Number.isFinite(costs[row][column])) {
      return impossibleAssignment(rowCount);
    }
    cost += costs[row][column];
  }

  return Object.freeze({
    cost,
    columns: Object.freeze(columns),
  });
}

export function minimumAssignmentCost(
  costs: readonly (readonly number[])[],
): number {
  return minimumAssignment(costs).cost;
}
