// Shared helpers of the test suite: test keys, JWTs in the three algorithms a deployment may
// use, and the HTTP sync stream reader.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const here = new URL('.', import.meta.url).pathname;
export const work = process.env.PSBUN_WORK ?? `${here}.work`;
const keysFile = `${work}/keys.json`;
const b64u = (b) => Buffer.from(b).toString('base64url');

/** Deterministic uuid for a seed label, the same derivation as fixture/schema.sql. */
export const uuid = (t) => { const h = crypto.createHash('md5').update(t).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; };

/** Creates the test key pairs once per work dir; they are test-only, never a secret. */
export function keys() {
  if (!fs.existsSync(keysFile)) {
    fs.mkdirSync(work, { recursive: true });
    const ed = crypto.generateKeyPairSync('ed25519');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = (k, extra) => ({ ...k.export({ format: 'jwk' }), ...extra });
    fs.writeFileSync(keysFile, JSON.stringify({
      private: { ed: jwk(ed.privateKey), rsa: jwk(rsa.privateKey) },
      jwks: { keys: [jwk(ed.publicKey, { kid: 'ed', alg: 'EdDSA', use: 'sig' }), jwk(rsa.publicKey, { kid: 'rsa', alg: 'RS256', use: 'sig' })] },
    }));
  }
  return JSON.parse(fs.readFileSync(keysFile, 'utf8'));
}

/** A client token for `sub`, signed with the Ed25519 key (`ed`) or the RSA key (`rsa`). */
export function jwt(sub, kind = 'ed', claims = {}) {
  const k = keys();
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: kind === 'ed' ? 'EdDSA' : 'RS256', typ: 'JWT', kid: kind }));
  const p = b64u(JSON.stringify({ sub, aud: 'powersync', iat: now, exp: now + 3600, ...claims }));
  const key = crypto.createPrivateKey({ key: k.private[kind], format: 'jwk' });
  const sig = crypto.sign(kind === 'ed' ? null : 'sha256', Buffer.from(`${h}.${p}`), key);
  return `${h}.${p}.${b64u(sig)}`;
}

export function psql(sql) {
  return execFileSync('docker', ['compose', 'exec', '-T', 'pg', 'psql', '-U', 'postgres', '-d', 'app', '-qAt', '-c', sql], { cwd: here, encoding: 'utf8' });
}

export const streamRequest = (subscriptions = []) => ({ buckets: [], include_checksum: true, raw_data: true, client_id: 'check', streams: { include_defaults: true, subscriptions } });

/** Opens POST /sync/stream and feeds each NDJSON line to onLine until it returns 'stop'. */
export async function openStream(port, token, onLine, signal, subscriptions) {
  const res = await fetch(`http://127.0.0.1:${port}/sync/stream`, {
    method: 'POST', signal,
    headers: { authorization: `Token ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(streamRequest(subscriptions)),
  });
  if (res.status !== 200) { const e = new Error(`HTTP ${res.status}: ${await res.text()}`); e.status = res.status; throw e; }
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim() && (await onLine(JSON.parse(l))) === 'stop') return; }
  }
}

/**
 * Collects one sync until its first complete checkpoint, the way a client does: it keeps every
 * operation it received (for the checksum check) and applies them in order to get the rows
 * the client ends up with. PUT sets a row, REMOVE deletes it, CLEAR empties the bucket, MOVE
 * carries no data.
 */
export function collector() {
  const st = { buckets: null, ops: [], final: new Map() };
  return {
    /** Feeds one sync line; returns true on checkpoint_complete. */
    line(m) {
      if (m.checkpoint) st.buckets = m.checkpoint.buckets.map((b) => ({ bucket: b.bucket, checksum: b.checksum, count: b.count, priority: b.priority }));
      if (m.data) {
        const bucket = m.data.bucket;
        if (!st.final.has(bucket)) st.final.set(bucket, new Map());
        const rows = st.final.get(bucket);
        for (const d of m.data.data) {
          st.ops.push({ bucket, op: d.op, type: d.object_type ?? null, id: d.object_id ?? null, data: d.data ?? null, checksum: Number(d.checksum) });
          const key = `${d.object_type}/${d.object_id}`;
          if (d.op === 'PUT') rows.set(key, d.data); else if (d.op === 'REMOVE') rows.delete(key); else if (d.op === 'CLEAR') rows.clear();
        }
      }
      return Boolean(m.checkpoint_complete);
    },
    done() {
      st.buckets.sort((a, b) => a.bucket.localeCompare(b.bucket));
      const final = [...st.final].flatMap(([bucket, rows]) => [...rows].map(([key, data]) => [bucket, key, data])).sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
      return { buckets: st.buckets, ops: st.ops, final };
    },
  };
}

/** Full initial sync of one user over NDJSON. */
export async function initialSync(port, token, subscriptions) {
  const c = collector();
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 180000);
  try { await openStream(port, token, (m) => (c.line(m) ? 'stop' : undefined), ac.signal, subscriptions); }
  finally { clearTimeout(t); ac.abort(); }
  return c.done();
}

/**
 * What a client checks before it applies a checkpoint: per bucket, the 32-bit sum of the
 * operation checksums it received equals the checksum the checkpoint announced.
 */
export function checksumsValid(st) {
  const sums = new Map();
  for (const r of st.ops) sums.set(r.bucket, ((sums.get(r.bucket) ?? 0) + r.checksum) >>> 0);
  return st.buckets.every((b) => (sums.get(b.bucket) ?? 0) === (b.checksum >>> 0));
}

/**
 * The comparable summary of one sync.
 *  - dataHash: the rows the client ends up with. Equal between runtimes in every scenario.
 *  - opsHash: every operation with its checksum, in a fixed order. Equal only on untouched
 *    seed data: storage that saw deletes or another image carries a different history, and
 *    even two runs of the same image differ in the checksum of a REMOVE.
 */
export function summarise(st) {
  const ops = st.ops.slice().sort((a, b) => (a.bucket + a.type + a.id + a.op).localeCompare(b.bucket + b.type + b.id + b.op));
  return { buckets: st.buckets.length, ops: st.ops.length, finalRows: st.final.length, checksumsValid: checksumsValid(st), dataHash: sha(st.final), opsHash: sha({ buckets: st.buckets, ops }) };
}
export const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
