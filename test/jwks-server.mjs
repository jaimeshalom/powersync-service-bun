// Serves the test JWKS over HTTP, the way an auth backend does (client_auth.jwks_uri).
import http from 'node:http';
import { keys } from './lib.mjs';
const body = JSON.stringify(keys().jwks);
http.createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); })
  .listen(Number(process.argv[2] ?? 18199), '127.0.0.1');
