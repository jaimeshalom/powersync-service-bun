// The one way the patch scripts edit upstream code. A patch names the original code exactly
// (a regular expression) and the text only the patched form contains. A file is patched only
// when the original appears exactly as often as expected; it is left alone when it already
// holds the patched form; any other shape stops the build, because the upstream code changed
// and the patch must be reviewed rather than silently skipped.
import fs from 'node:fs';

const count = (text, needle) => text.split(needle).length - 1;

/**
 * @param {string} file
 * @param {{ name: string, re: RegExp, to: string, done: string, times?: number }} patch
 *   `to` may use $1… for the groups of `re`; `done` is a string only the patched form holds.
 * @returns {string} one line saying what happened, for the build log
 */
export function rewrite(file, { name, re, to, done, times = 1 }) {
  const src = fs.readFileSync(file, 'utf8');
  const all = new RegExp(re.source, 'g');
  const found = src.match(all)?.length ?? 0;
  const patched = count(src, done);
  if (found === 0 && patched === times) return `already applied: ${name} (${file})`;
  if (found !== times || patched !== 0) {
    throw new Error(`${name}: expected the original code ${times} time(s) in ${file}, found it ${found} time(s) and the patched form ${patched} time(s). The upstream code changed: review the patch.`);
  }
  const out = src.replace(all, to);
  if (count(out, done) !== times) throw new Error(`${name}: the replacement did not produce the patched form in ${file}`);
  fs.writeFileSync(file, out);
  return `patched: ${name} (${file})`;
}

/** Runs `main` and turns a thrown error into one line on stderr and exit code 4. */
export function run(main) {
  try { main(); } catch (e) { console.error(String(e?.message ?? e)); process.exit(4); }
}
