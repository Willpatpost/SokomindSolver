#!/bin/bash
#SBATCH --job-name=sokov2test
#SBATCH --partition=cpu-2
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=2
#SBATCH --time=01:00:00
#SBATCH --output=sokov2-%j.out
#SBATCH --error=sokov2-%j.err

export PATH="/home/wpost003/local/node-v22.16.0-linux-x64/bin:$PATH"
cd /home/wpost003/alphaevolve/practice/Sokomind/Sokomind3

echo "=== ENV ==="
echo "Host: $(hostname)"
echo "Node: $(node --version)"
echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "CPU: $(lscpu | grep 'Model name' | sed 's/.*: *//')"
echo ""

echo "=== PHASE 1 ==="
npm run test:solver:huge 2>&1
P1_EXIT=$?
echo "Exit: $P1_EXIT"
echo ""

echo "=== PHASE 2 ==="
ARTIFACT="tests/fixtures/solver-v2/baseline-v3-${SLURM_JOB_ID:-manual}-$(date -u +%Y%m%dT%H%M%SZ).json"
npm run benchmark:solver:v2 -- \
  --save="$ARTIFACT" \
  2>&1
echo ""

echo "=== SUMMARY ==="
echo "P1: $P1_EXIT"
