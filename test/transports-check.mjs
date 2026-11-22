// usage: transports-check.mjs <api port> <out.json>
// The two other transports the PowerSync SDKs use, besides NDJSON over HTTP (check.mjs):
//  - RSocket over WebSocket with JSON payloads, the default of the web SDK;
//  - the binary BSON stream over HTTP.
// Each must deliver the same rows as the NDJSON stream of the same user, with valid checksums.
import fs from 'node:fs';
import { BSON } from 'bson';
import WebSocket from 'ws';
import { RSocketConnector } from 'rsocket-core';
import { WebsocketClientTransport } from 'rsocket-websocket-client';
import { uuid, jwt, initialSync, summarise, streamRequest, collector } from './lib.mjs';
const [port, outFile] = process.argv.slice(2);
const token = jwt(uuid('user7'));
const buf = (v) => Buffer.from(JSON.stringify(v));
// The service answers a WebSocket stream in JSON or in BSON depending on its version: accept both.
const decode = (b) => (b[0] === 0x7b ? JSON.parse(b.toString('utf8')) : BSON.deserialize(b, { promoteLongs: true, useBigInt64: false }));
async function viaWebSocket() {
  const c = collector();
  const rsocket = await new RSocketConnector({
    transport: new WebsocketClientTransport({ url: `ws://127.0.0.1:${port}/sync/stream`, wsCreator: (url) => new WebSocket(url) }),
    setup: { keepAlive: 20000, lifetime: 90000, dataMimeType: 'application/json', metadataMimeType: 'application/json',
      payload: { data: null, metadata: buf({ token: `Token ${token}`, user_agent: 'transports-check' }) } },
  }).connect();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket sync timed out')), 60000);
      const res = rsocket.requestStream({ data: buf(streamRequest()), metadata: buf({ path: '/sync/stream' }) }, 10, {
        onError: (e) => { clearTimeout(timer); reject(e); }, onComplete: () => {}, onExtension: () => {},
        onNext: (payload) => { res.request(1); if (payload.data && c.line(decode(payload.data))) { clearTimeout(timer); resolve(c.done()); } },
      });
    });
  } finally { rsocket.close(); }
}

async function viaBsonHttp() {
  const c = collector(); const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 60000);
  const res = await fetch(`http://127.0.0.1:${port}/sync/stream`, { method: 'POST', signal: ac.signal,
    headers: { authorization: `Token ${token}`, 'content-type': 'application/json', accept: 'application/vnd.powersync.bson-stream;q=0.9,application/x-ndjson;q=0.8' },
    body: JSON.stringify(streamRequest()) });
  const contentType = res.headers.get('content-type');
  if (res.status !== 200 || contentType !== 'application/vnd.powersync.bson-stream') throw new Error(`HTTP ${res.status}, content-type ${contentType}`);
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of res.body) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
        const size = pending.readInt32LE(0); const doc = BSON.deserialize(pending.subarray(0, size), { promoteLongs: true, useBigInt64: false }); pending = pending.subarray(size);
        if (c.line(doc)) return { contentType, st: c.done() };
      }
    }
    throw new Error('the BSON stream ended before checkpoint_complete');
  } finally { clearTimeout(timer); ac.abort(); }
}

const out = {};
const reference = summarise(await initialSync(port, token));
for (const [name, run] of [['websocket', viaWebSocket], ['bsonHttp', viaBsonHttp]]) {
  try { const r = await run(); const s = summarise(r.st ?? r); out[name] = { ok: s.dataHash === reference.dataHash && s.checksumsValid, sameRowsAsNdjson: s.dataHash === reference.dataHash, ...s }; }
  catch (e) { out[name] = { ok: false, error: String(e?.message ?? e) }; }
}
// A WebSocket with a bad token must be refused, not served.
try { const bad = await new RSocketConnector({ transport: new WebsocketClientTransport({ url: `ws://127.0.0.1:${port}/sync/stream`, wsCreator: (url) => new WebSocket(url) }),
    setup: { keepAlive: 20000, lifetime: 90000, dataMimeType: 'application/json', metadataMimeType: 'application/json', payload: { data: null, metadata: buf({ token: 'Token nope', user_agent: 'x' }) } } }).connect();
  out.websocketBadToken = await new Promise((resolve) => { const t = setTimeout(() => resolve('no answer'), 10000);
    bad.requestStream({ data: buf(streamRequest()), metadata: buf({ path: '/sync/stream' }) }, 1, { onError: () => { clearTimeout(t); resolve('refused'); }, onNext: () => { clearTimeout(t); resolve('served'); }, onComplete: () => {}, onExtension: () => {} });
    bad.onClose(() => { clearTimeout(t); resolve('refused'); }); });
} catch { out.websocketBadToken = 'refused'; }
fs.writeFileSync(outFile, JSON.stringify(out, null, 2)); console.log(JSON.stringify(out));
process.exit(out.websocket.ok && out.bsonHttp.ok && out.websocketBadToken === 'refused' ? 0 : 1);
