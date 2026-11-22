#!/bin/bash
# usage: tls-check.sh <image>
# TLS to Postgres, which the main suite does not use (it connects with sslmode=disable).
# A throwaway Postgres serves a certificate signed by a test CA. `test-connection` must:
#   pass  with sslmode verify-full and that CA           (the handshake and the verification work)
#   fail  with sslmode verify-full and a different CA    (the verification is real, not skipped)
# Prints tls.trusted_ca.exit and tls.wrong_ca.exit; exits 0 only for 0 and non-zero.
set -uo pipefail
IMG=$1; H=$(cd "$(dirname "$0")" && pwd); W=${PSBUN_WORK:-$H/.work}/tls; rm -rf "$W"; mkdir -p "$W"; cd "$W" || exit 1
ca() { openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$1" -keyout "$1.key" -out "$1.crt" 2>/dev/null; }
ca test-ca; ca other-ca
openssl req -newkey rsa:2048 -nodes -subj "/CN=localhost" -keyout server.key -out server.csr 2>/dev/null
printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > san.ext
openssl x509 -req -in server.csr -CA test-ca.crt -CAkey test-ca.key -CAcreateserial -days 2 -extfile san.ext -out server.crt 2>/dev/null
docker rm -f psbun-tls-pg >/dev/null 2>&1
docker run -d --name psbun-tls-pg -p 127.0.0.1:25433:5432 -e POSTGRES_PASSWORD=password -e POSTGRES_DB=app \
  -v "$W/server.crt:/tls/server.crt:ro" -v "$W/server.key:/tls/server.key:ro" postgres:18 \
  sh -c 'cp /tls/server.* /var/lib/postgresql/ && chown postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key &&
         exec docker-entrypoint.sh postgres -c wal_level=logical -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key' >/dev/null
for _ in $(seq 1 60); do docker exec psbun-tls-pg pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done; sleep 2
docker exec psbun-tls-pg psql -U postgres -d app -qAt -c 'create table t (id uuid primary key)' -c 'create publication powersync for all tables' -c 'create database ps_storage' >/dev/null
config() { # <ca file>
  { cat <<YAML
replication:
  connections:
    - type: postgresql
      uri: postgresql://postgres:password@localhost:25433/app
      sslmode: verify-full
      cacert: |
YAML
    sed 's/^/        /' "$1"
    cat <<YAML
storage:
  type: postgresql
  uri: postgresql://postgres:password@localhost:25433/ps_storage
  sslmode: verify-full
  cacert: |
YAML
    sed 's/^/    /' "$1"
    printf 'port: 18183\nsync_config:\n  content: |\n    config: { edition: 3 }\n    streams: { all: { auto_subscribe: true, queries: ["SELECT * FROM t"] } }\nclient_auth:\n  audience: ["powersync"]\ntelemetry: { disable_telemetry_sharing: true }\n'
  } > "$W/$2"; chmod 644 "$W/$2"; }
config test-ca.crt trusted.yaml; config other-ca.crt wrong.yaml
# `migrate up` first: it creates the storage schema over the same TLS settings, on its own.
try() { docker run --rm --network host -v "$W/$1:/app/powersync.yaml:ro" "$IMG" migrate up > "$W/$1.migrate.log" 2>&1
  docker run --rm --network host -v "$W/$1:/app/powersync.yaml:ro" "$IMG" test-connection > "$W/$1.log" 2>&1; echo $?; }
ok=$(try trusted.yaml); bad=$(try wrong.yaml)
docker rm -f psbun-tls-pg >/dev/null 2>&1
echo "tls.trusted_ca.exit=$ok"; echo "tls.wrong_ca.exit=$bad"
[ "$ok" = 0 ] && [ "$bad" != 0 ]
