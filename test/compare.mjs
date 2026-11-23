// usage: compare.mjs <reference> <variant>...
// Decides the gate. The reference is the official Node image of the same PowerSync version;
// every other variant must pass every step and serve exactly the same data. Writes
// report.json and report.md (with the resource table) into $PSBUN_WORK/results/.
import fs from 'node:fs';
import { work } from './lib.mjs';
const [ref, ...variants] = process.argv.slice(2);
const dir = `${work}/results`;
const summary = (n) => Object.fromEntries(fs.readFileSync(`${dir}/${n}/summary.txt`, 'utf8').trim().split('\n').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
const json = (n, f) => { try { return JSON.parse(fs.readFileSync(`${dir}/${n}/${f}`, 'utf8')); } catch { return null; } };
/**
 * What must match the reference: the rows a client ends up with, counts and status codes,
 * never timings. `withHistory` adds the operation checksums and `withOps` the operation count,
 * each comparable only where lib.mjs `summarise` says so.
 */
const stable = (c, withHistory, withOps) => {
  const sync = (s) => s && { buckets: s.buckets, finalRows: s.finalRows, dataHash: s.dataHash, ...(withOps ? { ops: s.ops } : {}), ...(withHistory ? { opsHash: s.opsHash } : {}) };
  return c && { users: Object.fromEntries(Object.entries(c.users).map(([k, v]) => [k, sync(v)])), onDemand: sync(c.onDemand), auth: c.auth, endpoints: c.endpoints, live: c.live?.ok };
};
const migrations = (s) => (s.migrations ?? '').split(',').filter(Boolean);
const byTimestamp = (a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]) || (a < b ? -1 : a > b ? 1 : 0);
const kinds = (s) => `${s.ops} operations${s.opKinds ? ` (${Object.entries(s.opKinds).sort().map(([k, v]) => `${v} ${k}`).join(', ')})` : ''}`;
const failures = []; const notes = []; const rows = [];
const all = [ref, ...variants]; const S = Object.fromEntries(all.map((n) => [n, summary(n)]));
for (const n of all) {
  const s = S[n]; const fail = (m) => failures.push(`${n}: ${m}`);
  for (const [k, v] of Object.entries(s)) if (/\.exit$|liveness_ok$/.test(k) && v !== '0') fail(`${k}=${v}`);
  if (s.aborted) { fail(s.aborted); continue; }
  const runners = s.mode === 'unified' ? ['api'] : ['api', 'sync'];
  for (const c of runners) {
    if (!(Number(s[`${c}.metrics_series`]) > 0)) fail(`${c} exports no powersync_ metrics`);
    if (!(Number(s[`${c}.log_json_lines`]) > 0)) fail(`${c} wrote no JSON log lines (NODE_ENV=production was not honoured)`);
    if (s[`${c}.exit_code`] === '137') fail(`${c} did not stop on SIGTERM and was killed`);
    if (Number(s[`${c}.restarts`]) >= 5) fail(`${c} crash-looped (${s[`${c}.restarts`]} restarts)`);
  }
  if (s.removed_api_hits !== '0') fail(`reached an API that --trim removed (${s.removed_api_hits ?? 'not counted'} log line(s) with ERR_FEATURE_REMOVED)`);
  if (s.image_user !== '901') fail(`image runs as user '${s.image_user}', not 901 like the upstream image`);
  // Storage migrations must run in the order of the timestamps that start their names, as they
  // do under Node: a later one can depend on an earlier one (scripts/patch-migration-order.mjs).
  const fresh = !/-(switch|rollback|upgrade)$/.test(n);
  if (s.migrations === undefined) fail('the storage migrations it ran were not recorded');
  else {
    const ran = migrations(s); const ordered = [...ran].sort(byTimestamp);
    if (ran.join() !== ordered.join()) fail(`ran its storage migrations out of order: ${ran.join(', ')}`);
    // On fresh storage every image runs the same migrations as the reference.
    else if (fresh && ran.join() !== migrations(S[ref]).join()) fail(`ran storage migrations ${ran.join(', ') || 'none'}; ${ref} ran ${migrations(S[ref]).join(', ') || 'none'}`);
  }
  for (const f of ['check.json', 'after-compact.json', 'after-ps-restart.json']) {
    // A variant started on storage another image already used carries that image's history.
    const c = json(n, f);
    if (!c) { fail(`${f} missing`); continue; }
    // after-ps-restart.json follows the database restarts; from there the operation count is history too.
    const args = [fresh && f === 'check.json', fresh && f !== 'after-ps-restart.json']; const r = json(ref, f);
    if (JSON.stringify(stable(r, ...args)) !== JSON.stringify(stable(c, ...args))) fail(`${f} differs from ${ref}`);
    else if (fresh && !args[1]) for (const [k, v] of [...Object.entries(c.users), ['onDemand', c.onDemand]]) {
      const w = k === 'onDemand' ? r.onDemand : r.users[k];
      if (v.ops !== w.ops) notes.push(`${n}: ${f}: ${k} received ${kinds(v)}, ${ref} ${kinds(w)}; the rows are the same`);
    }
    if ([...Object.values(c.users), c.onDemand].some((s) => !s.checksumsValid)) fail(`${f}: a bucket checksum does not match its operations`);
  }
  const tr = json(n, 'transports.json');
  if (!tr) fail('transports.json missing');
  else if (JSON.stringify([tr.websocket?.dataHash, tr.bsonHttp?.dataHash, tr.websocketBadToken]) !== JSON.stringify([json(ref, 'transports.json')?.websocket?.dataHash, json(ref, 'transports.json')?.bsonHttp?.dataHash, 'refused'])) fail(`transports.json differs from ${ref}`);
  const v = json(n, 'check.json')?.endpoints;
  if (v && (v.validate?.valid !== true || v.validateBroken?.valid !== false)) fail('sync-config validation gave the wrong verdict');
  const u = json(n, 'check.json')?.users ?? {};
  if (Object.keys(u).length !== 5 || Object.values(u).some((x) => !(x.finalRows > 0))) fail('initial sync returned no rows for some user');
  const mb = (k) => (s[k] ? Math.round(Number(s[k]) / 1024) : '-'); const load = json(n, 'load.json');
  rows.push({ variant: n, image: s.image, imageMB: Math.round(Number(s.image_bytes) / 1e6), startS: Number(s['api.liveness_after_s']).toFixed(1),
    apiIdleMB: mb('api.idle.rss_kb'), syncIdleMB: mb('sync.idle.rss_kb'), apiPeakMB: mb('api.final.peak_kb'), syncPeakMB: mb('sync.final.peak_kb'),
    apiCpuS: (Number(s['api.final.cpu_ms']) / 1000).toFixed(1), syncCpuS: s['sync.final.cpu_ms'] ? (Number(s['sync.final.cpu_ms']) / 1000).toFixed(1) : '-', stopS: Number(s.stop_s).toFixed(1),
    errorLogLines: runners.reduce((a, c) => a + Number(s[`${c}.log_error_lines`]), 0),
    restarts: runners.reduce((a, c) => a + Number(s[`${c}.restarts`]), 0),
    load: load && { clients: load.clients, connected: load.connected, initialP95: load.initialMs.p95, propagationP95: load.propagationMs.p95,
      apiLoadedMB: mb('api.loaded.peak_kb'), syncLoadedMB: mb('sync.loaded.peak_kb') } });
}
const md = ['| variant | image MB | start s | api idle MB | sync idle MB | api peak MB | sync peak MB | api CPU s | sync CPU s | stop s | error log lines | crash restarts |', '|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.variant} | ${r.imageMB} | ${r.startS} | ${r.apiIdleMB} | ${r.syncIdleMB} | ${r.apiPeakMB} | ${r.syncPeakMB} | ${r.apiCpuS} | ${r.syncCpuS} | ${r.stopS} | ${r.errorLogLines} | ${r.restarts} |`)];
if (rows.some((r) => r.load)) md.push('', '| variant | clients | connected | initial sync p95 ms | propagation p95 ms | api peak MB | sync peak MB |', '|---|---|---|---|---|---|---|',
  ...rows.filter((r) => r.load).map((r) => `| ${r.variant} | ${r.load.clients} | ${r.load.connected} | ${r.load.initialP95} | ${r.load.propagationP95} | ${r.load.apiLoadedMB} | ${r.load.syncLoadedMB} |`));
if (notes.length) md.push('', 'Not part of the verdict (a longer history after the restarts, README "The gate"):', '', ...notes.map((x) => `- ${x}`));
md.push('', failures.length ? `**FAILED**\n\n${failures.map((f) => `- ${f}`).join('\n')}` : `**PASSED**: ${variants.join(', ')} serve the same data as ${ref}.`);
fs.writeFileSync(`${dir}/report.json`, JSON.stringify({ passed: failures.length === 0, reference: ref, failures, notes, rows }, null, 2));
fs.writeFileSync(`${dir}/report.md`, md.join('\n') + '\n'); console.log(md.join('\n'));
process.exit(failures.length ? 1 : 0);
