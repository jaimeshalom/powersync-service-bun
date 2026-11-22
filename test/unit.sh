#!/bin/bash
# Unit tests that need no Docker: the tag naming and the gate's verdict. Run from anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."
fails=0
eq() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: expected '$2', got '$3'"; fails=$((fails + 1)); fi; }
echo "image-tag.sh"
eq "a stable Bun drops its commit" 1.29.1-bun1.5.0-r1 "$(scripts/image-tag.sh 1.29.1 '1.5.0+abcdef123' 1)"
eq "a canary Bun keeps its commit" 1.29.1-bun1.4.6-canary.1-feccae1b6-r1 "$(scripts/image-tag.sh 1.29.1 '1.4.6-canary.1+feccae1b6' 1)"
eq "the recipe revision is the suffix" 1.30.0-bun1.5.2-r7 "$(scripts/image-tag.sh 1.30.0 '1.5.2+0000000' 7)"
eq "a tag holds no character Docker refuses" "" "$(scripts/image-tag.sh 1.29.1 '1.4.6-canary.1+feccae1b6' 1 | tr -d 'A-Za-z0-9._-')"
[ "$fails" = 0 ] || { echo "image-tag: $fails case(s) failed"; exit 1; }
node --test test/compare.test.mjs
