// @argus/server — local Node backend. Owns filesystem access, the node
// FileSystemPort impl (M1), chokidar watching (M6), and the HTTP+SSE API (M2+).
//
// M0 scope: a security-correct HTTP skeleton. The security posture is mandatory
// (boundaries.md §4) because this binds a filesystem-reading server on localhost:
//   - bind 127.0.0.1 only
//   - Host/Origin allowlist (defeats DNS rebinding regardless of CORS)
//   - per-launch bearer token on all /api + /stream routes (401 before any FS access)
//   - strict security headers
// /health is open (liveness; touches no filesystem) but still Host-checked.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { ADAPTER_FORMAT } from '@argus/adapter';

const HOST = '127.0.0.1';
const PORT = Number(process.env.ARGUS_PORT ?? 4317);
const TOKEN = process.env.ARGUS_TOKEN ?? randomBytes(32).toString('hex');

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    // Strict CSP — relevant once the server also serves the built web app.
    'content-security-policy': "default-src 'none'; connect-src 'self'; img-src 'self' data:",
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/** DNS-rebinding guard: Host must be exactly our bind, and any Origin must match. */
function hostAllowed(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  if (!ALLOWED_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  return true;
}

function tokenOk(req: IncomingMessage, url: URL): boolean {
  const auth = req.headers.authorization;
  if (auth === `Bearer ${TOKEN}`) return true;
  // EventSource cannot set headers → token may ride in the query string.
  return url.searchParams.get('token') === TOKEN;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? HOST}`);

  if (!hostAllowed(req)) {
    send(res, 403, { error: 'forbidden_host' });
    return;
  }

  // Liveness — open, but no filesystem access.
  if (url.pathname === '/health') {
    send(res, 200, { status: 'ok', format: ADAPTER_FORMAT });
    return;
  }

  // Everything else (the future /api + /stream) requires the per-launch token,
  // checked BEFORE any filesystem access.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/stream')) {
    if (!tokenOk(req, url)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (url.pathname === '/api/ping') {
      send(res, 200, { pong: true });
      return;
    }
    send(res, 404, { error: 'not_found', note: 'real endpoints land in prototype M2' });
    return;
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  // The token is printed for local launch; dev tooling reads it from here.
  // (Never logged with file contents/paths — boundaries.md §4 redaction policy.)
  process.stdout.write(
    `argus server on http://${HOST}:${PORT}  (format ${ADAPTER_FORMAT})\n` +
      `ARGUS_TOKEN=${TOKEN}\n`,
  );
});
