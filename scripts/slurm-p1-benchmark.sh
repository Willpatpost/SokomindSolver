#!/bin/bash
#SBATCH --job-name=sokop1bench
#SBATCH --partition=cpu-2
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --time=02:00:00
#SBATCH --output=sokop1bench-%j.out
#SBATCH --error=sokop1bench-%j.err

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SOKOMIND_PROJECT_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
export PATH="/home/wpost003/local/node-v22.16.0-linux-x64/bin:$PATH"
if [[ ! -f "$PROJECT_DIR/package.json" ]]; then
  echo "ERROR: project dir missing package.json: $PROJECT_DIR" >&2
  exit 2
fi
cd "$PROJECT_DIR"
mkdir -p results

echo "=== ENV ==="
echo "Host: $(hostname)"
echo "Node: $(node --version)"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CPU: $(lscpu | grep 'Model name' | sed 's/.*: *//')"
echo "Job: ${SLURM_JOB_ID:-manual}"
echo ""

JOB="${SLURM_JOB_ID:-manual}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

echo "=== CORRECTNESS GATE ==="
set +e
npm run test:solver:huge 2>&1
GATE=$?
set -e
if [[ "$GATE" -ne 0 ]]; then
  echo "Correctness gate failed; aborting benchmarks." >&2
  exit "$GATE"
fi
echo ""

run_ab() {
  local label="$1"
  local control_json="$2"
  local treatment_json="$3"
  echo "=== $label: CONTROL ==="
  SOKOMIND_TUNING_JSON="$control_json" \
    npm run benchmark:solver:v2 -- \
      --runs=5 --warmup=0 \
      --save="results/${label}-control-${JOB}-${STAMP}.jsonl" \
    2>&1
  echo ""
  echo "=== $label: TREATMENT ==="
  SOKOMIND_TUNING_JSON="$treatment_json" \
    npm run benchmark:solver:v2 -- \
      --runs=5 --warmup=0 \
      --save="results/${label}-treatment-${JOB}-${STAMP}.jsonl" \
    2>&1
  echo ""
}

run_ab "p1.3-first-push-walk" \
  '{"firstPushWalkWeight":0}' \
  '{"firstPushWalkWeight":0.05}'

run_ab "p1.2-keeper-arrival" \
  '{"moveAwareDiscovery":0}' \
  '{"moveAwareDiscovery":1}'

run_ab "p1.1-macro-intermediate" \
  '{"macroIntermediateQuota":0}' \
  '{"macroIntermediateQuota":2}'

echo "=== SUMMARY ==="
echo "All A/B benchmarks complete."
echo "Results in: results/"
ls -la results/*-${JOB}-*.jsonl 2>/dev/null || echo "(no artifacts found)"
