#!/bin/bash
# Starts the backing services (compose.yml), initiates the Mongo replica set, loads the schema
# and seed, and starts the JWKS server. Stop everything with env-down.sh.
set -euo pipefail
H=$(cd "$(dirname "$0")" && pwd); cd "$H"
W=${PSBUN_WORK:-$H/.work}; mkdir -p "$W"
docker compose up -d
for _ in $(seq 1 90); do docker compose exec -T pg pg_isready -U postgres -q && break; sleep 1; done
M=(docker compose exec -T mongo mongosh --quiet -u root -p password --authenticationDatabase admin)
for _ in $(seq 1 90); do "${M[@]}" --eval 'db.runCommand({ping:1}).ok' >/dev/null 2>&1 && break; sleep 1; done
"${M[@]}" --eval 'try { rs.status().ok } catch (e) { rs.initiate({_id: "rs0", members: [{_id: 0, host: "127.0.0.1:27017"}]}).ok }' >/dev/null
for _ in $(seq 1 60); do [ "$("${M[@]}" --eval 'db.hello().isWritablePrimary' 2>/dev/null)" = true ] && break; sleep 1; done
P=(docker compose exec -T pg psql -U postgres -d app -qAt -v ON_ERROR_STOP=1)
if [ "$("${P[@]}" -c "select to_regclass('public.todo') is not null")" != t ]; then "${P[@]}" < fixture/schema.sql; fi
"${P[@]}" -c "select 'todos=' || count(*) from todo"
if ! curl -sf -o /dev/null http://127.0.0.1:18199/; then
  nohup node jwks-server.mjs 18199 > "$W/jwks.log" 2>&1 & echo $! > "$W/jwks.pid"
  for _ in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:18199/ && break; sleep 0.3; done
fi
echo "environment up"
