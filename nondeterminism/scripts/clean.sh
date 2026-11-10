#!/bin/bash
# Removes everything the stand made in Docker: stuck rooms, the gate, the networks and the
# images, the coder room's and the Node base. Data in ~/stand-data is untouched.
#
#   scripts/clean.sh               everything
#   scripts/clean.sh --keep-base   everything but the Node base image (374 MB to download again)
set -e
cd "$(dirname "$0")/.."

rooms=$(docker ps -aq --filter label=stand)
[ -n "$rooms" ] && docker rm -f $rooms > /dev/null

if [ "$1" = "--keep-base" ]; then
  docker compose --profile build down --remove-orphans
  docker image rm -f stand-coder:2.1.310 > /dev/null 2>&1 || true
else
  docker compose --profile build down --rmi all --remove-orphans
fi

nets=$(docker network ls -q --filter label=stand)
[ -n "$nets" ] && docker network rm $nets > /dev/null

echo "stand: nothing of it is left in docker"
