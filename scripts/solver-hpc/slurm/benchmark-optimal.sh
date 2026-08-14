#!/bin/bash
#SBATCH --job-name=sokomind-bench-opt
#SBATCH --partition=cpu-2
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=4
#SBATCH --mem=16G
#SBATCH --time=08:00:00
#SBATCH --output=artifacts/slurm/benchmark-optimal-%j.out
#SBATCH --error=artifacts/slurm/benchmark-optimal-%j.err

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths. Both overrides are optional; the checkout is derived from this file by
# default so the job is not tied to one account or cluster layout.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SOKOMIND_PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/../../.." && pwd)}"
if [[ -n "${SOKOMIND_NODE_DIR:-}" ]]; then
  export PATH="$SOKOMIND_NODE_DIR:$PATH"
fi
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo "ERROR: SOKOMIND_PROJECT_DIR does not contain package.json: $PROJECT_DIR" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js must be available on PATH (or set SOKOMIND_NODE_DIR)." >&2
  exit 2
fi
cd "$PROJECT_DIR"

mkdir -p artifacts/slurm

# ---------------------------------------------------------------------------
# Environment info
# ---------------------------------------------------------------------------
echo "=== ENV ==="
echo "Host:      $(hostname)"
echo "Node:      $(node --version)"
echo "Date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CPU:       $(lscpu | grep 'Model name' | sed 's/.*: *//')"
echo "Memory:    $(free -h | awk '/Mem:/ {print $2}')"
echo "Job ID:    ${SLURM_JOB_ID:-local}"
echo "CPUs:      ${SLURM_CPUS_PER_TASK:-4}"
echo ""

# ---------------------------------------------------------------------------
# Waterfield timing adjustment
# ---------------------------------------------------------------------------
export SOKOMIND_TIMING_SCALE=2

# ---------------------------------------------------------------------------
# Run optimal benchmark
# ---------------------------------------------------------------------------
node --experimental-strip-types \
  --max-old-space-size=14336 \
  scripts/benchmark-sokomind-optimal.ts \
  --parallelism="${SLURM_CPUS_PER_TASK:-4}" \
  "$@"

EXIT_CODE=$?

echo ""
echo "=== DONE ==="
echo "Exit code: $EXIT_CODE"
echo "Finished:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit $EXIT_CODE
