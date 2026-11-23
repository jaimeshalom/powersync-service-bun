# syntax=docker/dockerfile:1
# Unofficial builds of the PowerSync service (Apache-2.0) that run on Bun instead of Node.
# Two final targets from one build of the upstream source:
#   aot  a single binary made by `bun compile` (ahead-of-time compiled)
#   jit  the same /app tree run by the Bun runtime
# README.md explains each flag and how to build, test, update and roll back.

ARG NODE_IMAGE=node:24-trixie-slim
ARG RUNTIME_IMAGE=debian:trixie-slim

# ── upstream source, built the way the upstream Dockerfile builds it ─────────────────────
# glibc on purpose: the upstream image is Alpine, and its native addons are musl builds
# that the glibc Bun binary cannot load.
FROM ${NODE_IMAGE} AS app
ARG POWERSYNC_VERSION
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN git clone --depth 1 --branch "v${POWERSYNC_VERSION}" https://github.com/powersync-ja/powersync-service.git . \
 && git rev-parse HEAD > UPSTREAM_SHA && rm -rf .git
RUN corepack enable pnpm && corepack install
RUN pnpm install --frozen-lockfile
RUN pnpm build:production \
 && rm -rf node_modules **/node_modules \
 && pnpm install --frozen-lockfile --prod --ignore-scripts
COPY scripts/patch-interop.sh /usr/local/bin/patch-interop.sh
RUN patch-interop.sh /app
COPY scripts/rewrite.mjs scripts/patch-perf.mjs scripts/patch-migration-order.mjs /opt/recipe/
RUN node /opt/recipe/patch-migration-order.mjs /app && node /opt/recipe/patch-perf.mjs /app bson-fatal sha256

# ── Bun ──────────────────────────────────────────────────────────────────────────────────
FROM ${RUNTIME_IMAGE} AS bun
ARG BUN_URL
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/bun.zip "${BUN_URL}" && unzip -q -j /tmp/bun.zip '*/bun' -d /usr/local/bin && rm /tmp/bun.zip \
 && bun --revision | tee /bun-revision

# ── ahead-of-time compile ────────────────────────────────────────────────────────────────
FROM bun AS compile
COPY --from=app /app /app
WORKDIR /app
COPY scripts/compile.sh scripts/deps-from-ts.mjs scripts/rewrite.mjs scripts/patch-perf.mjs /usr/local/bin/
RUN compile.sh /app /out

# ── shared runtime base: same user, workdir and probe directory as the upstream image ────
FROM ${RUNTIME_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 901 web && useradd -u 901 -g web -d /home/web -m web \
 && mkdir -p /app/.probes && chown -R web:web /app/.probes
WORKDIR /app
ENV NODE_ENV=production
ARG SHA
ENV SHA=${SHA}

FROM runtime AS jit
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=app /app/ /app/
USER 901
ENTRYPOINT ["bun", "service/lib/entry.js"]
CMD ["start"]

FROM runtime AS aot
COPY --from=compile /out/powersync /usr/local/bin/powersync
COPY --from=compile /out/build-report.txt /out/trim-report.txt /usr/share/powersync/
COPY --from=app /app/UPSTREAM_SHA /app/LICENSE /usr/share/powersync/
USER 901
ENTRYPOINT ["powersync"]
CMD ["start"]
