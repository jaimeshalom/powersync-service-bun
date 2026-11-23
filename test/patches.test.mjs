// Tests of the build-time scripts (patch-perf.mjs, patch-migration-order.mjs, deps-from-ts.mjs)
// on a copy of the code they edit: the patched code must give exactly the results of the stock
// code, a second run must change nothing, and code of another shape must stop the build.
// The bson under test is the suite's own pinned copy, the version the service uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const scripts = path.join(here, '../scripts');
const require = createRequire(import.meta.url);
const stock = require('bson');
const BSON_DIR = path.resolve(path.dirname(require.resolve('bson')), '..'); // bson exports no package.json; 'bson' is lib/bson.cjs

// The upstream code the sha256 and migration-order patches edit, as PowerSync 1.29.1 builds it.
const UTILS = `import crypto from 'crypto';
export function hashData(type, id, data) {
    const hash = crypto.createHash('sha256');
    hash.update(\`put.\${type}.\${id}.\${data}\`);
    const buffer = hash.digest();
    return buffer.readUInt32LE(0);
}
export function hashDelete(sourceKey) {
    const hash = crypto.createHash('sha256');
    hash.update(\`delete.\${sourceKey}\`);
    const buffer = hash.digest();
    return buffer.readUInt32LE(0);
}
`;
const LOADER = `export class AbstractPowerSyncMigrationAgent extends framework.AbstractMigrationAgent {
    async loadInternalMigrations() {
        const migrationsDir = this.getInternalScriptsDir();
        const files = await fs.readdir(migrationsDir);
        const migrations = files.filter((file) => {
            return '.js' == path.extname(file);
        });
`;

/** A tree shaped like /app in the image, holding only the files the patches edit. */
function tree() {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'psbun-patches-'));
  fs.cpSync(BSON_DIR, path.join(app, 'node_modules/.pnpm/bson@6.10.4/node_modules/bson'), { recursive: true });
  for (const [f, body] of [['packages/service-core/dist/util/utils.js', UTILS], ['packages/service-core/dist/migrations/PowerSyncMigrationManager.js', LOADER]]) {
    fs.mkdirSync(path.dirname(path.join(app, f)), { recursive: true }); fs.writeFileSync(path.join(app, f), body);
  }
  return app;
}
const patch = (script, app, ...args) => { const p = spawnSync(process.execPath, [path.join(scripts, script), app, ...args], { encoding: 'utf8' }); return { status: p.status, out: p.stdout + p.stderr }; };

const app = tree();
test.after(() => fs.rmSync(app, { recursive: true, force: true }));
const bsonDir = path.join(app, 'node_modules/.pnpm/bson@6.10.4/node_modules/bson');
// The two stages as the Dockerfile runs them: the tree both images share, then the compile stage.
const shared = patch('patch-perf.mjs', app, 'bson-fatal', 'sha256');
const sharedLatin = fs.readFileSync(path.join(bsonDir, 'lib/bson.cjs'), 'utf8').includes('latinBytes.push(byte);');
const compiled = patch('patch-perf.mjs', app, 'bson-latin');

test('the shared tree gets bson-fatal and sha256 in both bson builds Bun loads and the TS sources', () => {
  assert.equal(shared.status, 0, shared.out);
  assert.equal(shared.out.match(/^patched: bson-fatal/gm)?.length, 3, shared.out);
  assert.match(shared.out, /^patched: sha256/m);
  assert.doesNotMatch(shared.out, /bson-latin/);
  assert.equal(sharedLatin, true, 'the JIT image keeps the stock Latin loop');
});

test('the compile stage adds bson-latin to the same three files', () => {
  assert.equal(compiled.status, 0, compiled.out);
  assert.equal(compiled.out.match(/^patched: bson-latin/gm)?.length, 3, compiled.out);
  assert.doesNotMatch(compiled.out, /bson-fatal|sha256/);
});

test('an unknown or missing edit name stops the build', () => {
  for (const args of [[], ['bson-latn']]) {
    const r = patch('patch-perf.mjs', app, ...args);
    assert.equal(r.status, 4, r.out); assert.match(r.out, /usage: patch-perf\.mjs <app dir> <edit>\.\.\./);
  }
});

test('a second run changes nothing', () => {
  const before = fs.readFileSync(path.join(bsonDir, 'lib/bson.cjs'), 'utf8');
  const r = patch('patch-perf.mjs', app, 'bson-fatal', 'sha256', 'bson-latin');
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out.match(/^already applied: /gm)?.length, 7, r.out);
  assert.equal(fs.readFileSync(path.join(bsonDir, 'lib/bson.cjs'), 'utf8'), before);
});

// Strings around the 20-byte limit of the Latin fast path, empty, non-ASCII, and a U+FFFD that
// is valid UTF-8 (only invalid bytes may throw).
const SAMPLES = ['', 'a', 'op', 'x'.repeat(19), 'y'.repeat(20), 'z'.repeat(21), 'é', 'añadir', 'ü'.repeat(10), 'ü'.repeat(11),
  '中文テキスト', '🙂 emoji', 'tab\tnew\nline', '\u0000nul', '\ufffd', 'ok \ufffd ok', '{"id":"7f3e","name":"Ana Núñez","n":42}'.repeat(8), 'q'.repeat(5000)];
// Keys cannot hold a NUL byte; values can.
const docs = () => SAMPLES.map((s, i) => ({ [s.slice(0, 15).replaceAll('\0', '') || 'k']: s, op: 'PUT', i, nested: { s, list: [s, `${s}${i}`] }, data: JSON.stringify({ s }) }));
// Bytes of {"s": <string of the given bytes>}: bson's string layout, with no validation on write.
const raw = (bytes) => {
  const str = Buffer.concat([Buffer.from(bytes), Buffer.from([0])]);
  const body = Buffer.concat([Buffer.from([0x02]), Buffer.from('s\0'), Buffer.alloc(4), str, Buffer.from([0])]);
  body.writeInt32LE(str.length, 3);
  const size = Buffer.alloc(4); size.writeInt32LE(body.length + 4); return Buffer.concat([size, body]);
};
const INVALID = [[0xc3, 0x28], [0x61, 0xff, 0x62], [...Buffer.from('a'.repeat(30)), 0xe2, 0x28, 0xa1], [0xf0, 0x9f, 0x99]];
const outcome = (lib, buf, opts) => { try { return { ok: lib.deserialize(buf, opts) }; } catch (e) { return { error: e.name, isBSONError: lib.BSONError.isBSONError(e) }; } };

for (const [name, load] of [['lib/bson.cjs', async () => require(path.join(bsonDir, 'lib/bson.cjs'))], ['lib/bson.node.mjs', () => import(path.join(bsonDir, 'lib/bson.node.mjs'))]]) {
  test(`patched ${name} decodes exactly like stock bson`, async () => {
    const patched = await load();
    const code = fs.readFileSync(path.join(bsonDir, name), 'utf8'); // the patched code is what runs
    assert.match(code, /string\.includes\('\\ufffd'\)/); assert.match(code, /latin \+= String\.fromCharCode\(byte\);/);
    for (const opts of [undefined, { validation: { utf8: true } }, { validation: { utf8: false } }]) {
      for (const d of docs()) {
        const buf = stock.serialize(d);
        assert.deepEqual(outcome(patched, buf, opts), outcome(stock, buf, opts));
      }
      for (const bytes of INVALID) assert.deepEqual(outcome(patched, raw(bytes), opts), outcome(stock, raw(bytes), opts));
    }
    // Invalid UTF-8 must still be refused where it was refused.
    assert.deepEqual(outcome(patched, raw([0xc3, 0x28]), { validation: { utf8: true } }), { error: 'BSONError', isBSONError: true });
  });
}

test('the patched checksums equal the stock ones', async () => {
  const stockUtils = path.join(app, 'stock-utils.mjs'); fs.writeFileSync(stockUtils, UTILS);
  const a = await import(stockUtils); const b = await import(path.join(app, 'packages/service-core/dist/util/utils.js'));
  assert.match(fs.readFileSync(path.join(app, 'packages/service-core/dist/util/utils.js'), 'utf8'), /crypto\.hash\('sha256', /);
  for (const s of SAMPLES) {
    assert.equal(b.hashData('lists', s, `{"v":"${s}"}`), a.hashData('lists', s, `{"v":"${s}"}`));
    assert.equal(b.hashDelete(s), a.hashDelete(s));
  }
  // And both are the first four bytes of the SHA-256, as clients verify them.
  assert.equal(b.hashDelete('x'), crypto.createHash('sha256').update('delete.x').digest().readUInt32LE(0));
});

test('code of another shape stops the build instead of being skipped', () => {
  const other = tree();
  try {
    const f = path.join(other, 'node_modules/.pnpm/bson@6.10.4/node_modules/bson/src/utils/latin.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('latinBytes.push(byte);', 'latinBytes[latinBytes.length] = byte;'));
    const r = patch('patch-perf.mjs', other, 'bson-latin');
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /bson-latin: expected the original code 1 time\(s\) in .*latin\.ts, found it 0 time\(s\).*review the patch/);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
});

test('patch-migration-order sorts the list readdir returns, once', () => {
  const f = path.join(app, 'packages/service-core/dist/migrations/PowerSyncMigrationManager.js');
  const r = patch('patch-migration-order.mjs', app);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /^patched: migration-order/m);
  assert.match(fs.readFileSync(f, 'utf8'), /const files = \(await fs\.readdir\(migrationsDir\)\)\.sort\(\);/);
  assert.match(patch('patch-migration-order.mjs', app).out, /^already applied: migration-order/m);
  fs.writeFileSync(f, LOADER.replace('const files = await fs.readdir(migrationsDir);', 'const files = await fs.readdir(dir);'));
  const bad = patch('patch-migration-order.mjs', app);
  assert.equal(bad.status, 4, bad.out); assert.match(bad.out, /migration-order: expected the original code/);
});

/** A tree with a driver at `mongoVersion` that resolves bson@`bsonVersion`, as pnpm lays it out. */
function driverTree(mongoVersion, bsonVersion) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'psbun-deps-'));
  const pnpm = path.join(app, 'node_modules/.pnpm');
  const mongo = path.join(pnpm, `mongodb@${mongoVersion}_x/node_modules/mongodb`);
  const bson = path.join(pnpm, `bson@${bsonVersion}/node_modules/bson`);
  for (const d of [mongo, bson]) fs.mkdirSync(path.join(d, 'src'), { recursive: true });
  for (const d of [mongo, bson]) fs.writeFileSync(path.join(d, 'src/index.ts'), '');
  fs.writeFileSync(path.join(mongo, 'package.json'), JSON.stringify({ name: 'mongodb', version: mongoVersion, main: 'lib/index.js' }));
  fs.writeFileSync(path.join(mongo, 'tsconfig.json'), '{\n  // the driver keeps comments here\n  "compilerOptions": { "target": "ES2021" }\n}\n');
  fs.writeFileSync(path.join(bson, 'package.json'), JSON.stringify({ name: 'bson', version: bsonVersion, main: './lib/bson.cjs', exports: { default: { require: './lib/bson.cjs' } } }));
  fs.symlinkSync(path.relative(path.dirname(mongo), bson), path.join(path.dirname(mongo), 'bson'));
  return { app, mongo, bson };
}
const pkg = (d) => JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8'));

test('deps-from-ts points a verified driver and its bson at their TS sources', () => {
  const t = driverTree('6.20.0', '6.10.4');
  try {
    const r = patch('deps-from-ts.mjs', t.app);
    assert.equal(r.status, 0, r.out); assert.equal(r.out.trim(), 'deps_from_ts=bson@6.10.4 mongodb@6.20.0');
    assert.equal(pkg(t.mongo).main, 'src/index.ts');
    assert.deepEqual(pkg(t.bson).exports, { default: { import: './src/index.ts', require: './src/index.ts' } });
    // Class fields keep the semantics of the published ES2021 build.
    for (const d of [t.mongo, t.bson]) assert.equal(JSON.parse(fs.readFileSync(path.join(d, 'tsconfig.json'), 'utf8')).compilerOptions.useDefineForClassFields, false);
  } finally { fs.rmSync(t.app, { recursive: true, force: true }); }
});

test('deps-from-ts keeps the published JavaScript of a version nobody verified, and says why', () => {
  const t = driverTree('6.21.0', '6.10.4');
  try {
    const before = [pkg(t.mongo), pkg(t.bson)];
    const r = patch('deps-from-ts.mjs', t.app);
    assert.equal(r.status, 0, r.out); assert.equal(r.out.trim(), 'deps_from_ts=none (not verified: mongodb@6.21.0)');
    assert.deepEqual([pkg(t.mongo), pkg(t.bson)], before);
    assert.equal(fs.existsSync(path.join(t.bson, 'tsconfig.json')), false);
  } finally { fs.rmSync(t.app, { recursive: true, force: true }); }
});
