#!/bin/bash
# usage: interop-still-needed.sh <jit image>
# Tells whether scripts/patch-interop.sh is still needed: it undoes the patch inside a
# throwaway container and imports the package under that image's Bun. Exit 0 and
# "still needed" while Bun gets `undefined`; exit 1 and "no longer needed" once the default
# import arrives as the class without the patch (then drop the patch and raise RECIPE_REVISION).
set -euo pipefail
out=$(docker run --rm -u 0 --entrypoint sh "$1" -c '
  f=$(find /app/node_modules/.pnpm -path "*mongodb-connection-string-url/.esm-wrapper.mjs" | head -1)
  [ -n "$f" ] || { echo no-wrapper; exit 0; }
  sed -i "s|export default mod\[\"default\"\] ?? mod;|export default mod[\"default\"];|" "$f"
  cd "$(dirname "$f")" && bun -e "import C from \"./.esm-wrapper.mjs\"; console.log(typeof C)"')
case $out in
  undefined) echo "still needed: the unpatched default import is undefined under this Bun" ;;
  *) echo "no longer needed: the unpatched import gives '$out'"; exit 1 ;;
esac
