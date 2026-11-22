// Tests of the gate's verdict (compare.mjs): a set of results that agree must pass, and each
// way a build can be wrong must turn it red. The results are synthetic, shaped like the files
// run-variant.sh writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);
const sync = (h) => ({ buckets: 2, ops: 54, finalRows: 54, checksumsValid: true, dataHash: `data-${h}`, opsHash: `ops-${h}` });
const check = () => ({
  users: Object.fromEntries([1, 2, 7, 25, 50].map((i) => [`user${i}`, sync(i)])), onDemand: sync('on-demand'),
  auth: { expired: 401, wrongAudience: 401, badSignature: 401, noToken: 401, adminWithoutToken: 401 },
  endpoints: { validate: { status: 200, valid: true, errors: [], parsed: 'p' }, validateBroken: { status: 200, valid: false, errors: ['e'] }, liveness: 200 },
  live: { ok: true, ms: { update: 10, insert: 11, remove: 12 } }, initialSyncMs: 100,
});
const transports = () => ({ websocket: { ok: true, dataHash: 't' }, bsonHttp: { ok: true, dataHash: 't' }, websocketBadToken: 'refused' });
const summary = (mode) => {
  const s = { image: 'img', storage: 'mongodb', mode, image_bytes: '300000000', image_user: '901', 'cmd.migrate.exit': '0', 'api.liveness_ok': '0',
    'api.liveness_after_s': '1.2', 'check.exit': '0', 'transports.exit': '0', stop_s: '0.3' };
  for (const c of mode === 'unified' ? ['api'] : ['api', 'sync']) Object.assign(s, { [`${c}.metrics_series`]: '9', [`${c}.log_json_lines`]: '50', [`${c}.log_error_lines`]: '2',
    [`${c}.exit_code`]: '0', [`${c}.restarts`]: '0', [`${c}.idle.rss_kb`]: '90000', [`${c}.final.peak_kb`]: '120000', [`${c}.final.cpu_ms`]: '400' });
  return s;
};

/** Writes the result files of each variant, lets `doctor` change them, and runs compare.mjs. */
function gate(variants, doctor = () => {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'psbun-compare-'));
  try {
    for (const [name, mode = 'split'] of variants) {
      const r = { name, summary: summary(mode), check: check(), afterCompact: check(), afterRestart: check(), transports: transports() };
      doctor(r);
      const dir = path.join(work, 'results', name); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'summary.txt'), Object.entries(r.summary).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      for (const [file, body] of [['check.json', r.check], ['after-compact.json', r.afterCompact], ['after-ps-restart.json', r.afterRestart], ['transports.json', r.transports]]) {
        if (body) fs.writeFileSync(path.join(dir, file), JSON.stringify(body));
      }
    }
    const p = spawnSync(process.execPath, [path.join(here, 'compare.mjs'), ...variants.map(([n]) => n)], { env: { ...process.env, PSBUN_WORK: work }, encoding: 'utf8' });
    return { status: p.status, out: p.stdout + p.stderr };
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
const ALL = [['node'], ['jit'], ['aot'], ['aot-unified', 'unified'], ['aot-switch'], ['node-rollback']];
const red = (name, doctor, expected, variants = ALL) => test(name, () => {
  const r = gate(variants, doctor);
  assert.equal(r.status, 1, r.out); assert.match(r.out, expected);
});

test('results that agree pass, with a unified variant that has no sync runner', () => {
  const r = gate(ALL);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /\*\*PASSED\*\*/);
});

red('a variant that serves different rows fails', (r) => { if (r.name === 'aot') r.check.users.user7.dataHash = 'other'; }, /aot: check\.json differs from node/);
red('different rows after compaction fail', (r) => { if (r.name === 'jit') r.afterCompact.onDemand.dataHash = 'other'; }, /jit: after-compact\.json differs/);
red('different rows after a restart fail', (r) => { if (r.name === 'aot') r.afterRestart.users.user1.finalRows = 53; }, /aot: after-ps-restart\.json differs/);
red('on fresh storage the operation checksums must match too', (r) => { if (r.name === 'aot') r.check.users.user1.opsHash = 'other'; }, /aot: check\.json differs/);

test('on storage another image used, only the rows are compared, not the history', () => {
  const r = gate(ALL, (x) => { if (/-(switch|rollback)$/.test(x.name)) for (const c of [x.check, x.afterCompact, x.afterRestart]) { c.users.user1.opsHash = 'history'; c.users.user1.ops = 90; } });
  assert.equal(r.status, 0, r.out);
});
red('…but different rows there still fail', (r) => { if (r.name === 'aot-switch') r.check.users.user1.dataHash = 'other'; }, /aot-switch: check\.json differs/);

red('a failed step fails', (r) => { if (r.name === 'aot') r.summary['after_pg_restart.exit'] = '1'; }, /aot: after_pg_restart\.exit=1/);
red('a runner that never became live fails', (r) => { if (r.name === 'jit') { r.summary['api.liveness_ok'] = '1'; r.summary.aborted = 'the api runner never became live'; } }, /jit: the api runner never became live/);
red('a bucket checksum that does not match its operations fails', (r) => { if (r.name === 'aot') r.check.users.user2.checksumsValid = false; }, /aot: check\.json: a bucket checksum/);
red('an image that does not run as user 901 fails', (r) => { if (r.name === 'aot') r.summary.image_user = ''; }, /aot: image runs as user ''/);
red('text logs instead of JSON fail', (r) => { if (r.name === 'aot') r.summary['api.log_json_lines'] = '0'; }, /aot: api wrote no JSON log lines/);
red('no Prometheus metrics fails', (r) => { if (r.name === 'aot') r.summary['sync.metrics_series'] = '0'; }, /aot: sync exports no powersync_ metrics/);
red('a crash loop fails', (r) => { if (r.name === 'aot') r.summary['api.restarts'] = '5'; }, /aot: api crash-looped/);
red('a runner killed instead of stopped fails', (r) => { if (r.name === 'aot') r.summary['sync.exit_code'] = '137'; }, /aot: sync did not stop on SIGTERM/);
red('a missing result file fails', (r) => { if (r.name === 'aot') r.afterCompact = null; }, /aot: after-compact\.json missing/);
red('a different WebSocket or BSON result fails', (r) => { if (r.name === 'aot') r.transports.websocket.dataHash = 'other'; }, /aot: transports\.json differs/);
red('a WebSocket served to a bad token fails', (r) => { if (r.name === 'jit') r.transports.websocketBadToken = 'served'; }, /jit: transports\.json differs/);
red('an initial sync with no rows fails', (r) => { r.check.users.user50.finalRows = 0; }, /initial sync returned no rows/);
// Equal to the reference is not enough: every variant accepting a broken config agrees and is wrong.
red('a wrong validation verdict fails even when every variant agrees', (r) => { r.check.endpoints.validateBroken.valid = true; }, /sync-config validation gave the wrong verdict/);
