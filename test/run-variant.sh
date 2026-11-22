#!/bin/bash
# usage: run-variant.sh <name> <image> [mongodb|postgresql] [split|unified]
# Runs one image through the whole functional suite as a real deployment runs it, as the image's
# own user, with the config mounted at /app/powersync.yaml:
#   split    one `-r sync` container (replication) and one `-r api` container
#   unified  one `-r unified` container doing both
# Results go to $PSBUN_WORK/results/<name>/.
# Each step appends `<step>=<value>` to summary.txt; compare.mjs decides pass or fail.
set -u
H=$(cd "$(dirname "$0")" && pwd); cd "$H" || exit 1
W=${PSBUN_WORK:-$H/.work}; N=$1; IMG=$2; STORAGE=${3:-mongodb}; MODE=${4:-split}
if [ "$MODE" = unified ]; then RUNNERS="api"; else RUNNERS="api sync"; fi
OUT=$W/results/$N; rm -rf "$OUT"; mkdir -p "$OUT"; SUM=$OUT/summary.txt
say() { echo "$1" | tee -a "$SUM"; }
since() { awk -v a="$1" -v b="$(date +%s.%N)" 'BEGIN { printf "%.3f", b - a }'; }  # seconds since <timestamp>
M=(docker compose exec -T mongo mongosh --quiet -u root -p password --authenticationDatabase admin)
P=(docker compose exec -T pg psql -U postgres -d app -qAt)

# A clean storage and no leftover slot, unless KEEP_STORAGE=1 (an upgrade test: one image, then
# the next on the same storage, so the storage migrations of the newer one run on start).
if [ -z "${KEEP_STORAGE:-}" ]; then
  "${M[@]}" --eval 'db.getSiblingDB("ps_test").dropDatabase()' >/dev/null
  "${P[@]}" -c "select pg_drop_replication_slot(slot_name) from pg_replication_slots" >/dev/null
  docker compose exec -T pg psql -U postgres -qAt -c "drop database if exists ps_test" -c "create database ps_test" >/dev/null
fi
if [ "$STORAGE" = mongodb ]; then SURI='mongodb://127.0.0.1:27299/?directConnection=true&authSource=admin'; SUSER=root; CFG=powersync.yaml
else SURI='postgresql://127.0.0.1:25432/ps_test'; SUSER=postgres; CFG=powersync-postgres-storage.yaml; fi
COMMON=(--network host -e PS_PG_USER=postgres -e PS_PG_PASSWORD=password -e "PS_STORAGE_URI=$SURI"
  -e "PS_STORAGE_USER=$SUSER" -e PS_STORAGE_PASSWORD=password -e PS_JWKS_URL=http://127.0.0.1:18199/jwks -e PS_API_TOKEN=devtoken
  -v "$H/$CFG:/app/powersync.yaml:ro" -v "$H/fixture/sync_streams.yaml:/cfg/sync_streams.yaml:ro")
# The runners restart when they crash, as an orchestrator restarts a pod. The reference image
# itself can exit when its storage database goes away; `restarts` in the summary counts it.
run() { docker run --restart on-failure:5 "${COMMON[@]}" -e PS_PORT="$2" -e PS_METRICS_PORT="$3" --name "psbun-$N-$1" "${@:4}"; }
# The live check after a disruption: the runners may still be reconnecting, so retry it.
live_check() { for _ in 1 2 3 4; do wait_live; node check.mjs 18180 "$OUT/$1.json" live > "$OUT/$1.out" 2>&1 && return 0; sleep 5; done; return 1; }
wait_live() { for _ in $(seq 1 240); do curl -sf -o /dev/null http://127.0.0.1:18180/probes/liveness && return 0; sleep 0.25; done; return 1; }
# Peak memory and CPU time of a container from its cgroup (v2); VmHWM as a fallback.
usage() { local c=$1 pid cg; pid=$(docker inspect -f '{{.State.Pid}}' "psbun-$N-$c")
  cg=/sys/fs/cgroup$(cut -d: -f3 "/proc/$pid/cgroup" 2>/dev/null | head -1)
  say "$c.$2.rss_kb=$(awk '/VmRSS/{print $2}' "/proc/$pid/status" 2>/dev/null)"
  say "$c.$2.peak_kb=$( (cat "$cg/memory.peak" 2>/dev/null | awk '{print int($1/1024)}') || awk '/VmHWM/{print $2}' "/proc/$pid/status")"
  say "$c.$2.cpu_ms=$(awk '/usage_usec/{print int($2/1000)}' "$cg/cpu.stat" 2>/dev/null)"; }

say "image=$IMG"; say "storage=$STORAGE"; say "mode=$MODE"
say "image_bytes=$(docker image inspect -f '{{.Size}}' "$IMG")"
say "image_user=$(docker image inspect -f '{{.Config.User}}' "$IMG")"

# One-shot commands a deployment runs as Jobs.
for cmd in "migrate up" "test-connection"; do
  # shellcheck disable=SC2086
  docker run --rm "${COMMON[@]}" -e PS_PORT=18182 -e PS_METRICS_PORT=19566 "$IMG" $cmd > "$OUT/cmd-${cmd%% *}.log" 2>&1; say "cmd.${cmd%% *}.exit=$?"
done

t0=$(date +%s.%N)
if [ "$MODE" = unified ]; then run api 18180 19564 -d "$IMG" start -r unified >/dev/null
else run sync 18181 19565 -d "$IMG" start -r sync >/dev/null; run api 18180 19564 -d "$IMG" start -r api >/dev/null; fi
wait_live; live=$?; say "api.liveness_ok=$live"
if [ "$live" != 0 ]; then  # nothing below can pass: keep the logs and stop here
  for c in $RUNNERS; do docker logs "psbun-$N-$c" > "$OUT/$c.log" 2>&1; docker rm -f "psbun-$N-$c" >/dev/null; done
  say "aborted=the api runner never became live"; exit 1
fi
say "api.liveness_after_s=$(since "$t0")"
node check.mjs 18180 "$OUT/check.json" full > "$OUT/check.out" 2>&1; say "check.exit=$?"
node transports-check.mjs 18180 "$OUT/transports.json" > "$OUT/transports.out" 2>&1; say "transports.exit=$?"
for c in $RUNNERS; do port=$([ $c = api ] && echo 19564 || echo 19565)
  curl -s -m5 "http://127.0.0.1:$port/metrics" > "$OUT/metrics-$c.txt"; say "$c.metrics_series=$(grep -c '^powersync_' "$OUT/metrics-$c.txt")"; done
sleep 3; for c in $RUNNERS; do usage "$c" idle; done

if [ -n "${LOAD_CLIENTS:-}" ]; then
  node load.mjs 18180 "$LOAD_CLIENTS" "${LOAD_SECONDS:-30}" "$OUT/load.json" > "$OUT/load.out" 2>&1; say "load.exit=$?"
  for c in $RUNNERS; do usage "$c" loaded; done
fi

# Compaction on live storage, the way the CronJob runs it.
docker run --rm "${COMMON[@]}" -e PS_PORT=18182 -e PS_METRICS_PORT=19566 "$IMG" compact > "$OUT/cmd-compact.log" 2>&1; say "cmd.compact.exit=$?"
node check.mjs 18180 "$OUT/after-compact.json" full > "$OUT/after-compact.out" 2>&1; say "after_compact.exit=$?"

# Postgres restarts under a running replication stream.
docker compose restart pg >/dev/null 2>&1
for _ in $(seq 1 60); do "${P[@]}" -c 'select 1' >/dev/null 2>&1 && break; sleep 1; done
live_check after-pg-restart; say "after_pg_restart.exit=$?"
# The storage database restarts.
if [ "$STORAGE" = mongodb ]; then docker compose restart mongo >/dev/null 2>&1
  for _ in $(seq 1 90); do [ "$("${M[@]}" --eval 'db.hello().isWritablePrimary' 2>/dev/null)" = true ] && break; sleep 1; done
  live_check after-storage-restart; say "after_storage_restart.exit=$?"; fi
for c in $RUNNERS; do say "$c.restarts=$(docker inspect -f '{{.RestartCount}}' "psbun-$N-$c")"; done
# PowerSync itself restarts on already-migrated storage; SIGTERM must end it cleanly and fast.
# shellcheck disable=SC2046
t1=$(date +%s.%N); docker stop -t 30 $(for c in $RUNNERS; do echo "psbun-$N-$c"; done) >/dev/null; say "stop_s=$(since "$t1")"
for c in $RUNNERS; do say "$c.exit_code=$(docker inspect -f '{{.State.ExitCode}}' "psbun-$N-$c")"; done
# shellcheck disable=SC2046
docker start $(for c in $RUNNERS; do echo "psbun-$N-$c"; done) >/dev/null; wait_live
node check.mjs 18180 "$OUT/after-ps-restart.json" full > "$OUT/after-ps-restart.out" 2>&1; say "after_ps_restart.exit=$?"
for c in $RUNNERS; do usage "$c" final; done
for c in $RUNNERS; do
  docker logs "psbun-$N-$c" > "$OUT/$c.log" 2>&1
  say "$c.log_json_lines=$(grep -c '^{' "$OUT/$c.log")"; say "$c.log_other_lines=$(grep -vc '^{' "$OUT/$c.log")"
  say "$c.log_error_lines=$(grep -c '"level":"error"' "$OUT/$c.log")"
done
# Stop before removing: a killed replication runner keeps its lock until it expires (about a
# minute), and the next scenario on this storage would spend that minute waiting for it.
for c in $RUNNERS; do docker stop -t 30 "psbun-$N-$c" >/dev/null; docker rm -f "psbun-$N-$c" >/dev/null; done
