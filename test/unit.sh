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
echo "trim-check.sh"
report() { printf '%s\n' "$@" > "$tmp/report.txt"; scripts/trim-check.sh "$tmp/report.txt" 2>&1 | tail -1; }
tmp=$(mktemp -d); fails=0
eq "a trimmed build passes and prints its figures" "trimmed: 22 feature(s) removed, 246 kept, 12000 kB saved, binary 99 MB, blocked by: dynamic-import eval" \
  "$(report binary_bytes=99000000 binary_bytes_untrimmed=111000000 trim_saved_bytes=12000000 trim_removed=22 trim_kept=246 'trim_blocked_by=dynamic-import eval')"
eq "a report with no trim figures fails" "the build report has no trim_removed: the binary was not built with --trim" "$(report binary_bytes=99000000 migrations=40)"
eq "a build where --trim removed nothing fails" "--trim removed nothing (trim_removed=0)" "$(report binary_bytes=99 trim_saved_bytes=0 trim_removed=0 trim_kept=268)"
eq "a trimmed binary that is not smaller fails" "the trimmed binary is not smaller than the untrimmed one (trim_saved_bytes=0)" "$(report binary_bytes=99 trim_saved_bytes=0 trim_removed=22)"
eq "…and so does a larger one" "the trimmed binary is not smaller than the untrimmed one (trim_saved_bytes=-5)" "$(report binary_bytes=99 trim_saved_bytes=-5 trim_removed=22)"
rm -rf "$tmp"
[ "$fails" = 0 ] || { echo "trim-check: $fails case(s) failed"; exit 1; }
node --test test/compare.test.mjs
