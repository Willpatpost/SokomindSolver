#!/bin/bash
#SBATCH --job-name=sokomind-solve
#SBATCH --partition=cpu-2
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=8G
#SBATCH --time=04:00:00
#SBATCH --array=0-0
#SBATCH --output=artifacts/slurm/solve-%A-%a.out
#SBATCH --error=artifacts/slurm/solve-%A-%a.err

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
export PATH="/home/wpost003/local/node-v22.16.0-linux-x64/bin:$PATH"
PROJECT_DIR="/home/wpost003/alphaevolve/practice/Sokomind/Sokomind3"
cd "$PROJECT_DIR"

# Manifest and output dir: set via sbatch --export or env vars
MANIFEST="${SOKOMIND_MANIFEST:-${1:-}}"
OUTPUT_DIR="${SOKOMIND_OUTPUT_DIR:-${2:-artifacts/results}}"

if [[ -z "$MANIFEST" ]]; then
  echo "ERROR: No manifest path. Set SOKOMIND_MANIFEST or pass as argument." >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
mkdir -p artifacts/slurm

# ---------------------------------------------------------------------------
# Environment info
# ---------------------------------------------------------------------------
echo "=== ENV ==="
echo "Host:      $(hostname)"
echo "Node:      $(node --version)"
echo "Date:      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CPU:       $(lscpu | grep 'Model name' | sed 's/.*: *//')"
echo "Job ID:    ${SLURM_JOB_ID:-local}"
echo "Array ID:  ${SLURM_ARRAY_TASK_ID:-0}"
echo "Manifest:  $MANIFEST"
echo "Output:    $OUTPUT_DIR"
echo ""

# ---------------------------------------------------------------------------
# Waterfield timing adjustment
# ---------------------------------------------------------------------------
export SOKOMIND_TIMING_SCALE=2

# ---------------------------------------------------------------------------
# Run task
# ---------------------------------------------------------------------------
TASK_INDEX="${SLURM_ARRAY_TASK_ID:-0}"

node --experimental-strip-types \
  scripts/solver-hpc/run-array-task.ts \
  --manifest="$MANIFEST" \
  --task-index="$TASK_INDEX" \
  --output-dir="$OUTPUT_DIR"

EXIT_CODE=$?

echo ""
echo "=== DONE ==="
echo "Exit code: $EXIT_CODE"
echo "Finished:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
exit $EXIT_CODE
