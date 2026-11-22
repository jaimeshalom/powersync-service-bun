# powersync-service-bun

Unofficial container images of the [PowerSync service](https://github.com/powersync-ja/powersync-service)
that run on [Bun](https://bun.sh) instead of Node.js. Not affiliated with or supported by the
PowerSync or Bun teams (see `NOTICE`).

Every image is built from the upstream source at a release tag, and is published only after
it serves exactly the same data as the official Node image of that version (see "The gate").

| Image | What it is |
|---|---|
| `ghcr.io/jaimeshalom/powersync-service-bun-aot:<tag>` | **AOT**: one binary made by `bun compile --trim`. Smallest and fastest to start. |
| `ghcr.io/jaimeshalom/powersync-service-bun-jit:<tag>` | **JIT**: the same code run by the Bun runtime. The fallback if a compiler bug appears. |

Both are drop-in replacements for `journeyapps/powersync-service`: the same commands
(`start -r api`, `start -r sync`, `migrate`, `compact`, `test-connection`), the same
`/app/powersync.yaml` default config path, the same user (901) and the same environment.

## Tags

`<powersync>-bun<bun>-r<recipe>`, for example `1.29.1-bun1.5.0-r1`.

- A tag is immutable: it is never rebuilt or deleted.
- `<recipe>` is `RECIPE_REVISION`. Raise it in the same change that alters what goes into the
  image (`Dockerfile`, `scripts/compile.sh`, `scripts/patch-interop.sh`).
- A canary Bun keeps its commit in the tag (`bun1.4.6-canary.1-feccae1b6`), because two
  canaries share a version number.
- `channels/latest.json` names the newest build that passed the gate, with its digests.
  `channels/<powersync version>.json` keeps the newest build of each PowerSync version.
  Deploy by digest, and follow `channels/latest.json` to learn about new builds.

## The gate

`scripts/gate.sh <powersync version> <aot image> <jit image>` runs everything below on
MongoDB bucket storage and again on Postgres bucket storage. The reference is the official
Node image of the same version, run through the same steps.

| Scenario | What it proves |
|---|---|
| `jit`, `aot` | a fresh deployment of each image, replication (`-r sync`) and API (`-r api`) in two containers |
| `jit-unified`, `aot-unified` | the same with one `-r unified` container |
| `aot-switch` | the AOT image starts on storage the Node image created: adopting a build |
| `node-rollback` | the Node image starts on storage the AOT image used: the way back |
| `aot-upgrade` | this build starts on the storage of the previous published build |

Each scenario runs as the image's own user, with a config in the shape of a real deployment
(`test/powersync.yaml`), and its runners restart when they crash, as a pod does:

- `migrate up`, `test-connection` and `compact` as one-shot commands;
- initial sync of five users over NDJSON, with both an Ed25519 and an RSA key from a JWKS URL;
  rows, bucket checksums and operation checksums must equal the reference byte for byte;
- an on-demand stream with a client parameter;
- the same sync over RSocket/WebSocket and over the binary BSON stream;
- every bucket checksum must equal the sum of its operations, as a client verifies it;
- expired, wrong-audience, tampered and missing tokens must be refused;
- write checkpoints, diagnostics, sync-config validation (valid and broken), probes;
- an update, an insert and a delete must arrive through live replication;
- a short load step (`LOAD_CLIENTS`, default 100 streams);
- Postgres restarts, the storage database restarts, PowerSync restarts on SIGTERM;
- the Prometheus endpoint exports metrics, and logs are JSON (`NODE_ENV=production`);
- TLS to Postgres with `sslmode: verify-full`: the right CA connects, a wrong CA is refused
  (`test/tls-check.sh`);
- no step may reach an API that `--trim` left out of the AOT binary (`ERR_FEATURE_REMOVED` in
  any log), and the binary must really be a trimmed one (`scripts/trim-check.sh`).

Not covered: MySQL, SQL Server and Convex as replication sources, MongoDB over TLS, and the
upstream unit tests under Bun. The gate proves the cases above, not every configuration.

`test/compare.mjs` decides pass or fail and writes the resource table (image size, start
time, memory at rest and at peak, CPU time, crash restarts) into `report.md`; the workflow
shows it in the run summary and stores it in `channels/*.json`. `test/unit.sh` tests that
verdict itself: a doctored result must turn the gate red.

The seed data is deterministic (`test/fixture/schema.sql`). Operation checksums are compared
only on untouched seed data: after a delete, two runs of the *same* image already differ in
the checksum of the REMOVE operation, so later steps compare the rows a client ends up with.
The number of operations is compared until the databases restart. After that it has differed
by one between images that served the same rows (replication is at least once: what was in
flight when a connection dropped is written again), so the report lists such a difference,
with the operation kinds and how many are repeats, without failing on it.

## Building locally

Needs Docker, Node 22+ and `jq`.

```sh
eval "$(scripts/resolve-versions.sh latest auto | sed 's/^/export /')"
for t in aot jit; do
  docker build --target $t --build-arg POWERSYNC_VERSION=$POWERSYNC_VERSION \
    --build-arg BUN_URL=$BUN_URL -t psb:$t .
done
scripts/gate.sh "$POWERSYNC_VERSION" psb:aot psb:jit
```

`scripts/resolve-versions.sh [powersync|latest] [bun|canary|auto]` picks the versions. `auto`
takes the newest stable Bun that has `bun compile` and falls back to canary only while no
stable release ships the compiler.

## Updating

The `Build` workflow runs every six hours and on demand.

- **A new stable PowerSync or Bun:** the scheduled run sees a tag that does not exist yet,
  builds it, runs the gate, publishes both images and commits `channels/latest.json`.
  Nothing is published when the gate fails; the run summary says which step differed.
- **A specific pair:** run the workflow by hand with `powersync` and `bun` set
  (`gh workflow run build.yml -f powersync=1.29.1 -f bun=1.5.0`). Clear `set_latest` to
  publish the images without moving `channels/latest.json`.
- **Canary builds are not rebuilt on the schedule** once a PowerSync version has one: canary
  moves daily. Run the workflow by hand to take a newer canary.
- **A change to the recipe:** raise `RECIPE_REVISION` in the same commit.

Before deploying a build whose `newStorageMigrations` in `channels/latest.json` is not
empty, read the upstream release notes: storage migrations run when the service starts and
cannot be undone.

## Rolling back

| Roll back | How | Safe when |
|---|---|---|
| Bun only (same PowerSync) | deploy the older tag of the same PowerSync version | always: the storage format is the same |
| AOT to JIT | deploy the same tag of the `-jit` image | always |
| To the official Node image | deploy `journeyapps/powersync-service:<version>` | always for the same PowerSync version (`node-rollback` in the gate) |
| PowerSync to an older version | deploy `channels/<older version>.json` | only if no storage migration ran in between (`newStorageMigrations` was empty); otherwise follow the upstream downgrade notes |

## Why the recipe looks like this

- **Built from source on glibc.** The official image is Alpine since 1.28, and its native
  addons are musl builds that the glibc Bun cannot load.
- **`scripts/patch-interop.sh`.** One upstream dependency exports its class in a way Bun
  reads differently from Node; without the one-line change PowerSync stops at start under
  Bun. The script explains the mechanism. `test/interop-still-needed.sh` shows when a new
  Bun or a new version of the package makes it unnecessary.
- **`scripts/compile.sh`.** The compiler cannot see files that are read from disk or
  imported dynamically at run time; the script lists them and says why each one is there.
  Its report of compiler warning classes is kept in the image at
  `/usr/share/powersync/build-report.txt`.
- **`--trim`.** The AOT binary leaves out the Bun and Node.js APIs the service never calls
  (the Bun command line, the JIT and AOT compilers, `node:vm` and others), so it is smaller
  and carries less code that could be reached. `/usr/share/powersync/trim-report.txt` in the
  image lists what was removed and why each kept API is kept, and `aot.build` in
  `channels/*.json` has the sizes with and without trimming. The service still creates code
  from strings (its JSON-schema and routing libraries call `new Function`), so the compiler
  keeps the interpreter and cannot prove as much unused as it could otherwise. A code path
  the gate does not exercise could still reach a removed API and fail with
  `ERR_FEATURE_REMOVED`: the JIT image of the same tag is untrimmed, and is the way back.
- **Size flags measured and not used.** `--no-compile-function-source` (19.6 MB smaller)
  and `--trim-locales=en` (5.6 MB smaller) were measured in PR #1; the gate passed with both.
  They are left out because about 10 % of the image is not worth the failure modes:
  `Function.prototype.toString()` returns no source, which libraries that generate code
  can read, and `--trim-locales=en` ends the process when a locale other than `en` is
  requested, which a client or the environment decides, not this repo. The gate covers
  a test schema, not every path the service can take.
- **What does not work under AOT:** hooks that patch modules at load time
  (require-in-the-middle), so Sentry/OpenTelemetry auto-instrumentation is inert.
  PowerSync's own Prometheus metrics work and are part of the gate.

## License

The recipe and test suite are Apache-2.0 (`LICENSE`). The published images contain the
PowerSync service (Apache-2.0) and Bun (MIT); see `NOTICE`.
