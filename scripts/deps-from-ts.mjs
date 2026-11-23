// usage: bun deps-from-ts.mjs <app dir>
// Points the MongoDB driver and the bson copy it uses at the TypeScript sources both packages
// ship in src/, so the AOT compiler builds them from typed code instead of the published
// JavaScript. Only the compile stage runs it: the JIT image keeps the published JavaScript.
//
// Why: the compiler turns a property access into a single load only where it can prove the
// object's shape, and the types let it prove more. In the measurements in README.md it took
// another 8 % off the API runner's CPU and 4–7 % off replication, on top of patch-perf.mjs.
// bson and mongodb are the only hot dependencies of the service that ship their TS sources.
//
// The sources must compile to what the published build compiled them to. Both packages
// publish TypeScript compiled with target ES2021, where class fields are assigned in the
// constructor (useDefineForClassFields false); Bun's transpiler defaults to define semantics,
// so the tsconfig of each package says so. Each version below was checked against its
// published build. A version not listed keeps the published JavaScript: the build goes on,
// and `deps_from_ts=none` in build-report.txt says why. To add a version, check its
// published lib/ target and run the gate.
import fs from 'node:fs';
import path from 'node:path';

const VERIFIED = { bson: ['6.10.4'], mongodb: ['6.20.0'] };

const app = process.argv[2];
const pnpm = path.join(app, 'node_modules/.pnpm');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
const report = (line) => { console.log(`deps_from_ts=${line}`); process.exit(0); };

const drivers = fs.readdirSync(pnpm).filter((d) => /^mongodb@\d/.test(d));
if (drivers.length !== 1) report(`none (expected one mongodb package, found ${drivers.length})`);
const mongo = path.join(pnpm, drivers[0], 'node_modules/mongodb');
const bson = fs.realpathSync(path.join(pnpm, drivers[0], 'node_modules/bson')); // the copy the driver resolves
const mp = readJson(path.join(mongo, 'package.json'));
const bp = readJson(path.join(bson, 'package.json'));
const unverified = [['mongodb', mp.version], ['bson', bp.version]].filter(([n, v]) => !VERIFIED[n].includes(v));
if (unverified.length) report(`none (not verified: ${unverified.map(([n, v]) => `${n}@${v}`).join(' ')})`);
for (const d of [mongo, bson]) if (!fs.existsSync(path.join(d, 'src/index.ts'))) report(`none (${d} ships no src/index.ts)`);
if (mp.exports) report('none (mongodb has an exports map this script does not rewrite)');
// The driver ships the tsconfig it is built with (with // comment lines, which JSON.parse refuses).
const tsconfig = path.join(mongo, 'tsconfig.json');
const mt = JSON.parse(fs.readFileSync(tsconfig, 'utf8').replace(/^\s*\/\/.*$/gm, ''));
if (mt.compilerOptions?.target !== 'ES2021') report(`none (mongodb is built with target ${mt.compilerOptions?.target}, not ES2021)`);

bp.main = bp.module = './src/index.ts';
bp.exports = { default: { import: './src/index.ts', require: './src/index.ts' } };
writeJson(path.join(bson, 'package.json'), bp);
writeJson(path.join(bson, 'tsconfig.json'), { compilerOptions: { target: 'ES2021', useDefineForClassFields: false } });

mt.compilerOptions.useDefineForClassFields = false;
writeJson(tsconfig, mt);
mp.main = 'src/index.ts';
writeJson(path.join(mongo, 'package.json'), mp);
console.log(`deps_from_ts=bson@${bp.version} mongodb@${mp.version}`);
