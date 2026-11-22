// usage: load.mjs <api port> <clients> <seconds> <out.json>
// A short load step for the resource figures: <clients> sync streams stay open while one row per
// second changes for a user that 1 in 50 clients follows. It reports how many streams connected,
// initial-sync and propagation latency, and errors. It is a smoke load, not a capacity benchmark.
import fs from 'node:fs';
import { uuid, jwt, psql, openStream } from './lib.mjs';
const [port, clients, seconds, outFile] = process.argv.slice(2);
const N = Number(clients); const ac = new AbortController();
const q = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : null);
const initial = []; const propagation = []; let connected = 0; let errors = 0; const sent = new Map();
const t0 = Date.now();
const runs = Array.from({ length: N }, (_, c) => {
  const user = (c % 50) + 1; let ready = false;
  return openStream(port, jwt(uuid('user' + user), c % 2 ? 'rsa' : 'ed'), (m) => {
    if (m.checkpoint_complete && !ready) { ready = true; connected++; initial.push(Date.now() - t0); }
    for (const d of m.data?.data ?? []) { const mk = /load-(\d+)/.exec(d.data ?? ''); if (ready && mk && sent.has(mk[1])) propagation.push(Date.now() - sent.get(mk[1])); }
  }, ac.signal).catch((e) => { if (!ac.signal.aborted) { errors++; if (errors < 4) console.error(String(e)); } });
});
// A fixed number of writes, one per second, so every variant leaves the same operation history.
let n = 0;
while (n < Number(seconds)) {
  n++; sent.set(String(n), Date.now());
  psql(`update todo set note='load-${n}' where id='${uuid('todo1-1-2')}'`);
  await new Promise((r) => setTimeout(r, 1000));
}
await new Promise((r) => setTimeout(r, 2000));
const out = { clients: N, connected, errors, writes: n, initialMs: { p50: q(initial, 0.5), p95: q(initial, 0.95) }, propagationMs: { p50: q(propagation, 0.5), p95: q(propagation, 0.95), samples: propagation.length } };
ac.abort(); await Promise.allSettled(runs);
psql(`update todo set note='note note ' where id='${uuid('todo1-1-2')}'`);
fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); console.log(JSON.stringify(out));
process.exit(connected === N && errors === 0 && propagation.length > 0 ? 0 : 1);
