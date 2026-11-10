#!/bin/bash
# Pilot matrix for the library project: 3 inputs x 3 models at medium effort,
# plus Sonnet at low and max effort on raw and truth. 7 runs per cell.
cd "$(dirname "$0")/.."
P="--project library --runs 7 --parallel 2"

for spec in raw ai-opus-5-5 truth; do
  for model in claude-haiku-5-5 claude-sonnet-5-5 claude-opus-5-5; do
    node lib/run.mjs $P --spec "$spec" --model "$model" --effort medium &
  done
  wait
done

for spec in raw truth; do
  for effort in low max; do
    node lib/run.mjs $P --spec "$spec" --model claude-sonnet-5-5 --effort "$effort" &
  done
done
wait
echo "matrix done"
