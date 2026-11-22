#!/bin/bash
# usage: image-tag.sh <powersync version> <bun revision> <recipe revision>
# The immutable tag of a build: <powersync>-bun<bun>-r<recipe>. A stable Bun revision
# "1.5.0+abc123" becomes "bun1.5.0"; a canary "1.4.6-canary.1+abc123" keeps its commit,
# because two canaries share a version number. Docker tags cannot hold a "+".
set -euo pipefail
ver=${2%%+*}; sha=${2#*+}
case $ver in *canary*) bun="$ver-$sha" ;; *) bun=$ver ;; esac
echo "$1-bun$bun-r$3"
