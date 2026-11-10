#!/bin/bash
# Ten ai expansions of the raw library request by Opus (specs/ai-opus-5-5-01 .. -10), each
# compiled N times by Haiku (default 10) inside the rooms. See HYPOTHESES.md, "Ten ai expansions".
# An expansion that already exists is kept; compiles that already exist are kept too.
#   bash scripts/expansions-library.sh [N] >> ~/stand-data/logs/expansions-library.log 2>&1
cd "$(dirname "$0")/.."
RUNS="${1:-10}"

for i in 01 02 03 04 05 06 07 08 09 10; do
  if [ ! -f "projects/library/specs/ai-opus-5-5-$i.md" ]; then
    echo "== $(date -u +%FT%TZ) expand $i =="
    node lib/run.mjs --project library --expand raw --model claude-opus-5-5 --effort medium --tag "$i"
  fi
done

for i in 01 02 03 04 05 06 07 08 09 10; do
  echo "== $(date -u +%FT%TZ) compile ai-opus-5-5-$i -> $RUNS =="
  node lib/run.mjs --project library --spec "ai-opus-5-5-$i" --model claude-haiku-5-5 --effort medium --runs "$RUNS" --parallel 3
done
echo "== $(date -u +%FT%TZ) expansions done =="
