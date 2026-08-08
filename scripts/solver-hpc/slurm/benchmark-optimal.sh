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
# Paths
# ---------------------------------------------------------------------------
export PATH="/home/wpost003/local/node-v22.16.0-linux-x64/bin:$PATH"
PROJECT_DIR="/home/wpost003/alphaevolve/practice/Sokomind/Sokomind3"
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
