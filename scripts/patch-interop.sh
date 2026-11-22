#!/bin/sh
# Makes the MongoDB connection-string package importable under Bun.
#
# Its ESM wrapper does `export default mod["default"]`. Node hands `module.exports` to a default
# import; Bun honours `__esModule` and hands `exports.default`, so the class arrives undefined and
# PowerSync stops at start with "[PSYNC_S1109] invalid URI - undefined is not a constructor".
# The change is harmless under Node. test/interop-still-needed.sh tells when it can be dropped.
set -eu
found=0
for f in $(find "$1/node_modules/.pnpm" -path '*mongodb-connection-string-url/.esm-wrapper.mjs'); do
  found=1
  if grep -q 'export default mod\["default"\];' "$f"; then
    sed -i 's|export default mod\["default"\];|export default mod["default"] ?? mod;|' "$f"
    echo "patched $f"
  else
    echo "left as is (already compatible, or a new shape to review): $f"
  fi
done
[ "$found" = 1 ] || echo "mongodb-connection-string-url has no .esm-wrapper.mjs in this version"
