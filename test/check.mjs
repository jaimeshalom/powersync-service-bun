// usage: check.mjs <api port> <out.json> [full|live]
// Functional check of a running PowerSync API runner. `full` hashes the initial sync of several
// users and probes the HTTP API; both modes end with a live change that must arrive through
// replication. Every value that goes into the output must be identical across runtimes.
import fs from 'node:fs';
import { uuid, jwt, psql, openStream, initialSync, summarise, sha, here } from './lib.mjs';
const [port, outFile, mode = 'full'] = process.argv.slice(2);
const api = (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
const admin = (path, body) => api(path, { method: 'POST', headers: { authorization: 'Bearer devtoken', 'content-type': 'application/json' }, body: JSON.stringify(body) });
const out = { users: {}, onDemand: null, auth: {}, endpoints: {}, live: null };
const t0 = Date.now();

if (mode === 'full') {
  // Initial sync, alternating the two key types the JWKS serves.
  for (const [n, i] of [1, 2, 7, 25, 50].entries()) {
    const token = jwt(uuid('user' + i), n % 2 ? 'rsa' : 'ed');
    for (let attempt = 0; ; attempt++) {
      try { const st = await initialSync(port, token); out.users['user' + i] = summarise(st); break; }
      catch (e) { if (attempt > 60) throw e; await new Promise((r) => setTimeout(r, 2000)); }
    }
  }
  // An on-demand stream with a client parameter.
  const st = await initialSync(port, jwt(uuid('user1')), [{ stream: 'list_todos', parameters: { list: uuid('list1-2') }, override_priority: null }]);
  out.onDemand = summarise(st);

  // Authentication must reject what it should: status codes only, bodies differ in wording.
  const status = async (token) => { try { await openStream(port, token, () => 'stop', AbortSignal.timeout(10000)); return 200; } catch (e) { return e.status ?? String(e); } };
  out.auth.expired = await status(jwt(uuid('user1'), 'ed', { exp: Math.floor(Date.now() / 1000) - 60 }));
  out.auth.wrongAudience = await status(jwt(uuid('user1'), 'ed', { aud: 'someone-else' }));
  out.auth.badSignature = await status(jwt(uuid('user1')).slice(0, -6) + 'AAAAAA');
  out.auth.noToken = (await api('/sync/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;
  out.auth.adminWithoutToken = (await api('/api/admin/v1/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status;

  const wc = await api('/write-checkpoint2.json?client_id=check', { headers: { authorization: `Token ${jwt(uuid('user1'))}` } });
  out.endpoints.writeCheckpoint = { status: wc.status, keys: Object.keys((await wc.json()).data ?? {}) };
  const dg = await admin('/api/admin/v1/diagnostics', { sync_rules_content: true }); const dgj = await dg.json();
  out.endpoints.diagnostics = { status: dg.status, connections: dgj.data?.connections?.map((c) => ({ connected: c.connected, errors: c.errors?.length })),
    activeErrors: dgj.data?.active_sync_rules?.errors?.length, activeTables: dgj.data?.active_sync_rules?.connections?.[0]?.tables?.length };
  const vr = await admin('/api/sync-rules/v1/validate', { content: fs.readFileSync(`${here}fixture/sync_streams.yaml`, 'utf8') });
  // The parser's whole answer must match between runtimes, not only its verdict.
  const vj = await vr.json();
  out.endpoints.validate = { status: vr.status, valid: vj.valid, errors: vj.errors, parsed: sha({ b: vj.bucket_definitions, s: vj.source_tables, d: vj.data_tables }) };
  const bad = await admin('/api/sync-rules/v1/validate', { content: 'config: { edition: 3 }\nstreams:\n  x:\n    queries:\n      - SELECT nonsense FROM\n' });
  const bj = await bad.json();
  out.endpoints.validateBroken = { status: bad.status, valid: bj.valid, errors: bj.errors };
  out.endpoints.liveness = (await api('/probes/liveness')).status;
  out.endpoints.unknownRoute = (await api('/definitely-not-a-route')).status;
}
out.initialSyncMs = Date.now() - t0;

// Live replication: keep user1's stream open, change a row, wait for the new text. Then an
// insert and a delete, which travel as PUT and REMOVE operations.
// The marker and the new id derive from the output file name, so every variant writes the same
// operations in the same order and the bucket checksums stay comparable afterwards.
const step = outFile.split('/').pop();
const id = uuid('todo1-1-1'); const marker = 'live-' + step; const newId = uuid('new-' + step);
const seen = { update: null, insert: null, remove: null }; let ready = false; let tUpd = 0;
try {
  await openStream(port, jwt(uuid('user1')), (m) => {
    if (m.checkpoint_complete && !ready) {
      ready = true; tUpd = Date.now();
      psql(`update todo set text='${marker}' where id='${id}'`);
      psql(`insert into todo select '${newId}', user_id, list_id, 'inserted ${marker}', false, null, 99, 1.5, 1, '{}', '{}', null, false, '2026-01-02Z', null from todo where id='${id}'`);
      psql(`delete from todo where id='${newId}'`);
    }
    for (const d of m.data?.data ?? []) {
      if (!ready) continue;
      if (d.object_id === id && d.data?.includes(marker)) seen.update = Date.now() - tUpd;
      if (d.object_id === newId && d.op === 'PUT') seen.insert = Date.now() - tUpd;
      if (d.object_id === newId && d.op === 'REMOVE') seen.remove = Date.now() - tUpd;
    }
    if (seen.update !== null && seen.insert !== null && seen.remove !== null) return 'stop';
  }, AbortSignal.timeout(60000));
  out.live = { ok: true, ms: seen };
} catch (e) { out.live = { ok: false, seen, error: String(e) }; }
psql(`update todo set text='Todo ñ 日本 1 ✓ 🚀' where id='${id}'`);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out));
process.exit(out.live.ok ? 0 : 1);
