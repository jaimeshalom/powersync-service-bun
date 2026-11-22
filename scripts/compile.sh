#!/bin/sh
# usage: compile.sh <app dir> <out dir>
# AOT-compiles the built PowerSync tree into one binary. Why each input is listed:
#  - the storage migrations are found with readdir and loaded with a dynamic import(), so the
#    compiler cannot see them: they go in as extra entry points AND as assets;
#  - replication reads the .plpgsql files, and the Postgres TLS client its CA bundle, from disk
#    at run time: both go in as assets;
#  - --production: `bun compile` inlines process.env.NODE_ENV at build time. Without it the
#    binary logs text and puts stack traces in HTTP error bodies whatever the container sets.
set -eu
APP=$1; OUT=$2; mkdir -p "$OUT"; cd "$APP"
bun compile --help >/dev/null 2>&1 || { echo "this Bun has no 'bun compile'" >&2; exit 3; }
MIG=$(ls modules/module-mongodb-storage/dist/migrations/db/migrations/*.js modules/module-postgres-storage/dist/migrations/scripts/*.js)
# shellcheck disable=SC2086 # MIG is a list of entry points
bun compile --production service/lib/entry.js $MIG \
  --asset modules/module-postgres/sql \
  --asset packages/jpgwire/ca \
  --asset modules/module-mongodb-storage/dist/migrations/db/migrations \
  --asset modules/module-postgres-storage/dist/migrations/scripts \
  --outfile "$OUT/powersync" > "$OUT/build.log" 2>&1 || { tail -60 "$OUT/build.log"; exit 1; }
{
  echo "bun=$(bun --revision)"
  echo "binary_bytes=$(stat -c %s "$OUT/powersync")"
  echo "migrations=$(echo "$MIG" | wc -w)"
  echo "warning_classes:"
  grep -oE 'TS1[0-9]{5}' "$OUT/build.log" | sort | uniq -c || true
} | tee "$OUT/build-report.txt"
