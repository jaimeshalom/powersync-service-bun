#!/bin/bash
# usage: resolve-versions.sh [powersync version|latest] [bun version|canary|auto]
# Prints the versions a build uses, as KEY=value lines (also appended to $GITHUB_OUTPUT):
#   POWERSYNC_VERSION  the newest stable upstream release, unless one is given
#   BUN_URL            the Bun build to compile with
#   BUN_CHANNEL        stable | canary
# `auto` takes the newest stable Bun that has `bun compile`, and falls back to canary while no
# stable release ships the compiler. So the day a stable Bun brings it, builds move to stable
# on their own and never go back to canary.
set -euo pipefail
PS=${1:-latest}; BUN=${2:-auto}
api() { curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$1"; }
if [ "$PS" = latest ]; then PS=$(api powersync-ja/powersync-service/releases/latest | jq -r .tag_name); fi
PS=${PS#v}
has_compile() { # does the Bun build at this URL have `bun compile`?
  local d; d=$(mktemp -d); curl -fsSL -o "$d/bun.zip" "$1" && unzip -q -j "$d/bun.zip" '*/bun' -d "$d" && "$d/bun" compile --help >/dev/null 2>&1; }
canary=https://github.com/oven-sh/bun/releases/download/canary/bun-linux-x64.zip
case $BUN in
  canary) URL=$canary; CH=canary ;;
  auto)
    tag=$(api oven-sh/bun/releases/latest | jq -r .tag_name)
    URL=https://github.com/oven-sh/bun/releases/download/$tag/bun-linux-x64.zip; CH=stable
    if ! has_compile "$URL"; then echo "Bun $tag has no 'bun compile': using canary" >&2; URL=$canary; CH=canary; fi ;;
  *) URL=https://github.com/oven-sh/bun/releases/download/bun-v${BUN#bun-v}/bun-linux-x64.zip; CH=stable ;;
esac
{ echo "POWERSYNC_VERSION=$PS"; echo "BUN_URL=$URL"; echo "BUN_CHANNEL=$CH"; } | tee -a "${GITHUB_OUTPUT:-/dev/null}"
