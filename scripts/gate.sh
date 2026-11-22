#!/bin/bash
# usage: gate.sh <powersync version> <aot image> <jit image>
# The gate every build passes before it is published. The reference is the official Node image
# of the same PowerSync version. Against it, on MongoDB storage and again on Postgres storage:
#   jit, aot      a fresh deployment of each Bun image, replication and API in two containers
#   *-unified     the same with one `-r unified` container, the other common way to deploy
#   aot-switch    the AOT image started on storage the Node image created (adopting this build)
#   node-rollback the Node image started on storage the AOT image has used (the way back)
#   aot-upgrade   only with UPGRADE_FROM=<image>: this build started on that older build's storage
# Then TLS to Postgres with certificate verification, for the three images.
# Reports land in $PSBUN_WORK/<storage>/results/report.{md,json} and $PSBUN_WORK/tls.txt.
# Exit 0 only if everything passes.
set -uo pipefail
PS=$1; AOT=$2; JIT=$3
T=$(cd "$(dirname "$0")/../test" && pwd); ROOT=${PSBUN_WORK:-$T/.work}; NODE=journeyapps/powersync-service:$PS
export LOAD_CLIENTS=${LOAD_CLIENTS:-100} LOAD_SECONDS=${LOAD_SECONDS:-15}
[ -d "$T/node_modules" ] || (cd "$T" && npm ci --no-audit --no-fund >/dev/null)
docker pull -q "$NODE" >/dev/null
rc=0
for storage in mongodb postgresql; do
  export PSBUN_WORK=$ROOT/$storage; mkdir -p "$PSBUN_WORK"
  "$T/env-up.sh" >/dev/null || { echo "environment failed to start" >&2; exit 2; }
  run() { echo "── $storage: $1"; "$T/run-variant.sh" "$1" "$2" "$storage" "${3:-split}" > "$PSBUN_WORK/run-$1.log" 2>&1; }
  variants=(jit aot jit-unified aot-unified aot-switch node-rollback)
  run jit "$JIT"; run aot "$AOT"; run jit-unified "$JIT" unified; run aot-unified "$AOT" unified
  if [ -n "${UPGRADE_FROM:-}" ]; then run previous "$UPGRADE_FROM"; KEEP_STORAGE=1 run aot-upgrade "$AOT"; variants+=(aot-upgrade); fi
  run node "$NODE"
  KEEP_STORAGE=1 run aot-switch "$AOT"
  KEEP_STORAGE=1 run node-rollback "$NODE"
  (cd "$T" && node compare.mjs node "${variants[@]}") || rc=1
  "$T/env-down.sh" >/dev/null 2>&1
done
# TLS to Postgres with certificate verification, once per image (test/tls-check.sh).
export PSBUN_WORK=$ROOT; : > "$ROOT/tls.txt"
for pair in "node $NODE" "jit $JIT" "aot $AOT"; do
  # shellcheck disable=SC2086
  set -- $pair; echo "── tls: $1"
  if out=$("$T/tls-check.sh" "$2"); then verdict=passed; else verdict=FAILED; rc=1; fi
  echo "$1: $verdict ($(echo "$out" | tr '\n' ' '))" | tee -a "$ROOT/tls.txt"
done
exit $rc
