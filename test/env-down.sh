#!/bin/bash
# Stops the backing services and the JWKS server, and drops their data.
H=$(cd "$(dirname "$0")" && pwd); cd "$H" || exit 1; W=${PSBUN_WORK:-$H/.work}
[ -f "$W/jwks.pid" ] && kill "$(cat "$W/jwks.pid")" 2>/dev/null
docker compose down -v
