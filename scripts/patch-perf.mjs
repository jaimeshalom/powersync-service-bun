// usage: node patch-perf.mjs <app dir> <edit>...
// Edits to the built tree that keep every result the same and remove work the compiler or the
// JIT cannot make cheap. The Dockerfile names the edits each stage gets. The measurements are in
// README.md, "Why the recipe looks like this".
//
//  bson-fatal  The MongoDB driver asks bson to validate UTF-8, so after the native decode bson
//              scans every decoded string, one charCodeAt at a time, for U+FFFD. The patch makes
//              the same search with one native string.includes. On a hit it still re-decodes
//              with the strict decoder, which throws exactly as before. Both images.
//  sha256      Every operation checksum creates a Hash object, feeds it one string and digests
//              it. crypto.hash() computes the same digest in one call. Both images.
//  bson-latin  bson decodes every string of 20 bytes or less (each document key, most short
//              values) by pushing each byte into an array and calling
//              String.fromCharCode(...array). The patch appends to a string instead: the same
//              string, without the array and the spread call. The AOT binary only: compiled,
//              it decodes such documents 23-31 % faster, but a JIT optimises the array and the
//              spread well, and the patch made Bun's JIT and Node's mixed or slower.
//
// Every bson copy in the tree is patched: the Node builds that Bun loads (lib/bson.cjs,
// lib/bson.node.mjs) and the TypeScript sources the AOT build compiles instead of them
// (scripts/deps-from-ts.mjs). test/patches.test.mjs proves the patched bson decodes exactly
// like the stock one, and the patched checksums equal the stock ones.
import fs from 'node:fs';
import path from 'node:path';
import { rewrite, run } from './rewrite.mjs';

const LATIN = {
  name: 'bson-latin',
  re: /const latinBytes = \[\];(\s+)for \(let i = start; i < end; i\+\+\) \{(\s+)const byte = uint8array\[i\];(\s+)if \(byte > 127\) \{(\s+)return null;(\s+)\}(\s+)latinBytes\.push\(byte\);(\s+)\}(\s+)return String\.fromCharCode\(\.\.\.latinBytes\);/,
  to: "let latin = '';$1for (let i = start; i < end; i++) {$2const byte = uint8array[i];$3if (byte > 127) {$4return null;$5}$6latin += String.fromCharCode(byte);$7}$8return latin;",
  done: 'latin += String.fromCharCode(byte);',
};
const FATAL = {
  name: 'bson-fatal',
  re: /if \(fatal\) \{(\s+)for \(let i = 0; i < string\.length; i\+\+\) \{\s+if \(string\.charCodeAt\(i\) === 0xfffd\) \{\s+parseUtf8\(buffer, start, end, true\);\s+break;\s+\}\s+\}(\s+)\}/,
  to: "if (fatal && string.includes('\\ufffd')) {$1parseUtf8(buffer, start, end, true);$2}",
  done: "if (fatal && string.includes('\\ufffd')) {",
};
const SHA256 = {
  name: 'sha256',
  re: /const hash = crypto\.createHash\('sha256'\);\s+hash\.update\((`[^`]*`)\);\s+const buffer = hash\.digest\(\);/,
  to: "const buffer = crypto.hash('sha256', $1, 'buffer');",
  done: "crypto.hash('sha256', ",
  times: 2, // hashData and hashDelete
};

run(() => {
  const [app, ...edits] = process.argv.slice(2);
  const known = ['bson-fatal', 'sha256', 'bson-latin'];
  if (!app || edits.length === 0 || edits.some((e) => !known.includes(e))) {
    throw new Error(`usage: patch-perf.mjs <app dir> <edit>... (edits: ${known.join(' ')})`);
  }
  const pnpm = path.join(app, 'node_modules/.pnpm');
  const bsons = fs.readdirSync(pnpm).filter((d) => /^bson@\d/.test(d)).map((d) => path.join(pnpm, d, 'node_modules/bson'));
  if (bsons.length === 0) throw new Error(`no bson package under ${pnpm}`);
  for (const b of bsons) {
    if (edits.includes('bson-latin')) for (const f of ['lib/bson.cjs', 'lib/bson.node.mjs', 'src/utils/latin.ts']) console.log(rewrite(path.join(b, f), LATIN));
    if (edits.includes('bson-fatal')) for (const f of ['lib/bson.cjs', 'lib/bson.node.mjs', 'src/utils/node_byte_utils.ts']) console.log(rewrite(path.join(b, f), FATAL));
  }
  if (edits.includes('sha256')) console.log(rewrite(path.join(app, 'packages/service-core/dist/util/utils.js'), SHA256));
});
