#!/bin/bash
# usage: trim-check.sh <build-report.txt>
# Fails unless the report (scripts/compile.sh writes it, the AOT image carries it at
# /usr/share/powersync/build-report.txt) shows a binary that --trim really reduced. A build
# where the flag was dropped, or where the compiler stopped removing anything, must not pass
# as a trimmed build. Prints one line with the figures.
set -euo pipefail
val() { sed -n "s/^$1=//p" "$2" | head -1; }
removed=$(val trim_removed "$1"); saved=$(val trim_saved_bytes "$1"); bytes=$(val binary_bytes "$1")
[[ "$removed" =~ ^[0-9]+$ ]] || { echo "the build report has no trim_removed: the binary was not built with --trim" >&2; exit 1; }
[ "$removed" -gt 0 ] || { echo "--trim removed nothing (trim_removed=0)" >&2; exit 1; }
[[ "$saved" =~ ^[0-9]+$ ]] && [ "$saved" -gt 0 ] || { echo "the trimmed binary is not smaller than the untrimmed one (trim_saved_bytes=${saved:-missing})" >&2; exit 1; }
echo "trimmed: $removed feature(s) removed, $(val trim_kept "$1") kept, $((saved / 1000000)) MB saved, binary $((bytes / 1000000)) MB, blocked by: $(val trim_blocked_by "$1")"
