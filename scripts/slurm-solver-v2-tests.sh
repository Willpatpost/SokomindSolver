#!/bin/bash
#SBATCH --job-name=sokov2test
#SBATCH --partition=cpu-2
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --time=01:00:00
#SBATCH --output=sokov2-%j.out
#SBATCH --error=sokov2-%j.err

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SOKOMIND_PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
if [[ -n "${SOKOMIND_NODE_DIR:-}" ]]; then
  export PATH="$SOKOMIND_NODE_DIR:$PATH"
fi
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo "ERROR: SOKOMIND_PROJECT_DIR does not contain package.json: $PROJECT_DIR" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: Node.js and npm must be available on PATH (or set SOKOMIND_NODE_DIR)." >&2
  exit 2
fi
cd "$PROJECT_DIR"

echo "=== ENV ==="
echo "Host: $(hostname)"
echo "Node: $(node --version)"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CPU: $(lscpu | grep 'Model name' | sed 's/.*: *//')"
echo ""

echo "=== PHASE 1 ==="
set +e
npm run test:solver:huge 2>&1
P1_EXIT=$?
set -e
echo "Exit: $P1_EXIT"
echo ""
if [[ "$P1_EXIT" -ne 0 ]]; then
  echo "Correctness/performance gate failed; benchmark capture skipped." >&2
  exit "$P1_EXIT"
fi

echo "=== PHASE 2 ==="
ARTIFACT="tests/fixtures/solver-v2/baseline-v3-${SLURM_JOB_ID:-manual}-$(date -u +%Y%m%dT%H%M%SZ).json"
set +e
npm run benchmark:solver:v2 -- \
  --runs=5 \
  --warmup=0 \
  --save="$ARTIFACT" \
  2>&1
P2_EXIT=$?
set -e
echo ""

echo "=== SUMMARY ==="
echo "P1: $P1_EXIT"
echo "P2: $P2_EXIT"
echo "Artifact: $ARTIFACT"
exit "$P2_EXIT"
