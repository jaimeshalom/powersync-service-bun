#!/bin/sh
# usage: compile.sh <app dir> <out dir>
# AOT-compiles the built PowerSync tree into one binary. Why each input is listed:
#  - the storage migrations are found with readdir and loaded with a dynamic import(), so the
#    compiler cannot see them: they go in as extra entry points AND as assets;
#  - replication reads the .plpgsql files, and the Postgres TLS client its CA bundle, from disk
#    at run time: both go in as assets;
#  - --production: `bun compile` inlines process.env.NODE_ENV at build time. Without it the
#    binary logs text and puts stack traces in HTTP error bodies whatever the container sets;
#  - --trim: leaves out the Bun and Node.js APIs the service never calls, so the binary carries
#    less code that could be reached. A call that does reach a removed API throws
#    ERR_FEATURE_REMOVED; the gate fails on any (test/run-variant.sh, `removed_api_hits`).
#    trim-report.txt lists what was removed and why each kept API is kept (--explain=trim);
#  - deps-from-ts.mjs: the MongoDB driver and its bson are compiled from their TypeScript
#    sources, which the compiler can optimise further. It says why, and when it does not apply.
#  - patch-perf.mjs bson-latin: an edit to bson that only pays off compiled (it says why).
set -eu
APP=$1; OUT=$2; mkdir -p "$OUT"; cd "$APP"
bun compile --help >/dev/null 2>&1 || { echo "this Bun has no 'bun compile'" >&2; exit 3; }
bun "$(dirname "$0")/patch-perf.mjs" "$APP" bson-latin
DEPS=$(bun "$(dirname "$0")/deps-from-ts.mjs" "$APP"); echo "$DEPS"
MIG=$(ls modules/module-mongodb-storage/dist/migrations/db/migrations/*.js modules/module-postgres-storage/dist/migrations/scripts/*.js)
compile() { # <outfile> [extra flags...]
  out=$1; shift
  # shellcheck disable=SC2086 # MIG is a list of entry points
  bun compile --production "$@" service/lib/entry.js $MIG \
    --asset modules/module-postgres/sql \
    --asset packages/jpgwire/ca \
    --asset modules/module-mongodb-storage/dist/migrations/db/migrations \
    --asset modules/module-postgres-storage/dist/migrations/scripts \
    --outfile "$out"
}
compile "$OUT/powersync" --trim --explain=trim > "$OUT/build.log" 2>&1 || { tail -60 "$OUT/build.log"; exit 1; }
sed -n 's/^.*aot: trim: //p' "$OUT/build.log" > "$OUT/trim-report.txt"
# The same program without --trim, built only to measure what trimming saves. It is not shipped.
compile /tmp/powersync-untrimmed > /tmp/untrimmed.log 2>&1 || { tail -60 /tmp/untrimmed.log; exit 1; }
trimmed=$(stat -c %s "$OUT/powersync"); untrimmed=$(stat -c %s /tmp/powersync-untrimmed)
rm -f /tmp/powersync-untrimmed /tmp/untrimmed.log
{
  echo "bun=$(bun --revision)"
  echo "binary_bytes=$trimmed"
  echo "binary_bytes_untrimmed=$untrimmed"
  echo "trim_saved_bytes=$((untrimmed - trimmed))"
  echo "trim_removed=$(grep -c '^removed ' "$OUT/trim-report.txt" || true)"
  echo "trim_kept=$(grep -c '^kept ' "$OUT/trim-report.txt" || true)"
  echo "trim_blocked_by=$(sed -n 's/^blocked by \([a-z-]*\):.*/\1/p' "$OUT/trim-report.txt" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  echo "migrations=$(echo "$MIG" | wc -w)"
  echo "$DEPS"
  echo "warning_classes:"
  grep -oE 'TS1[0-9]{5}' "$OUT/build.log" | sort | uniq -c || true
} | tee "$OUT/build-report.txt"
