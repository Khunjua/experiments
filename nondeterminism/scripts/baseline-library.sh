#!/bin/bash
# Baseline for the library project: 3 inputs x 3 models at medium effort, N runs per cell
# (default 30), inside the rooms, one cell at a time (3 calls at once within a cell). Runs
# that already exist are kept; only the missing numbers are made, so the script can be run
# again with a larger N to top the cells up.
#   bash scripts/baseline-library.sh [N] >> ~/stand-data/logs/baseline-library.log 2>&1
cd "$(dirname "$0")/.."
RUNS="${1:-30}"

for model in claude-haiku-5-5 claude-sonnet-5-5 claude-opus-5-5; do
  for spec in raw ai-opus-5-5 truth; do
    echo "== $(date -u +%FT%TZ) $spec $model -> $RUNS =="
    node lib/run.mjs --project library --spec "$spec" --model "$model" --effort medium --runs "$RUNS" --parallel 3
  done
done
echo "== $(date -u +%FT%TZ) baseline done, $RUNS per cell =="
