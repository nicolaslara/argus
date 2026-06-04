// @argus/server — local Node backend. Owns filesystem access, the node
// FileSystemPort impl (M1), chokidar watching (M6), and the HTTP+SSE API (M2+).
//
// M0 scope: a security-correct HTTP skeleton. M3 adds the real read routes.
// The security posture is mandatory (boundaries.md §4) because this binds a
// filesystem-reading server on localhost:
//   - bind 127.0.0.1 only
//   - Host/Origin allowlist (defeats DNS rebinding regardless of CORS)
//   - per-launch bearer token on all /api + /stream routes (401 before any FS access)
//   - strict security headers
//   - path-escape guard (charset + resolve()-inside-claudeHome) before any FS read
// /health is open (liveness; touches no filesystem) but still Host-checked.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ADAPTER_FORMAT } from '@argus/adapter';
import { NodeFileSystemPort } from './fs-port.ts';
import {
  handleProjects,
  handleProjectRuns,
  handleProjectWorkflows,
  handleProjectPlan,
  handleRunSnapshot,
  type RouteDeps,
  type RouteResult,
} from './routes.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.ARGUS_PORT ?? 4317);
const TOKEN = process.env.ARGUS_TOKEN ?? randomBytes(32).toString('hex');

// The claude home we read runs from. Defaults to ~/.claude; overridable for tests.
const CLAUDE_HOME = resolve(process.env.ARGUS_CLAUDE_HOME ?? `${homedir()}/.claude`);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// One shared read-only port + route deps for the process lifetime.
const deps: RouteDeps = { port: new NodeFileSystemPort(), claudeHome: CLAUDE_HOME };

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

/** Decode a single path segment, rejecting anything that fails to decode cleanly. */
function decodeSegment(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/**
 * Dispatch the M3 read routes. Returns a RouteResult, or null if no route matched
 * (so the caller can 404). All FS access here is already token-gated by the caller;
 * the route layer additionally validates path segments + resolve()-guards the path.
 */
async function dispatchApi(pathname: string): Promise<RouteResult | null> {
  // GET /api/projects
  if (pathname === '/api/projects') {
    return handleProjects(deps);
  }

  // GET /api/projects/:slug/runs
  const runsMatch = /^\/api\/projects\/([^/]+)\/runs$/.exec(pathname);
  if (runsMatch) {
    const slug = decodeSegment(runsMatch[1]!);
    if (slug === null) return { status: 400, body: { error: 'bad_request' } };
    return handleProjectRuns(deps, slug);
  }

  // GET /api/projects/:slug/workflows/:file/plan (P1: the run-free static plan DAG).
  // More specific than the listing route → matched first.
  const planMatch = /^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/plan$/.exec(pathname);
  if (planMatch) {
    const slug = decodeSegment(planMatch[1]!);
    const file = decodeSegment(planMatch[2]!);
    if (slug === null || file === null) return { status: 400, body: { error: 'bad_request' } };
    return handleProjectPlan(deps, slug, file);
  }

  // GET /api/projects/:slug/workflows (P0: the run-free declared-workflow listing)
  const workflowsMatch = /^\/api\/projects\/([^/]+)\/workflows$/.exec(pathname);
  if (workflowsMatch) {
    const slug = decodeSegment(workflowsMatch[1]!);
    if (slug === null) return { status: 400, body: { error: 'bad_request' } };
    return handleProjectWorkflows(deps, slug);
  }

  // GET /api/runs/:slug/:session/:runId
  const runMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (runMatch) {
    const slug = decodeSegment(runMatch[1]!);
    const session = decodeSegment(runMatch[2]!);
    const runId = decodeSegment(runMatch[3]!);
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleRunSnapshot(deps, slug, session, runId);
  }

  return null;
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

  // Everything else (the /api + future /stream) requires the per-launch token,
  // checked BEFORE any filesystem access (boundaries.md §4).
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/stream')) {
    if (!tokenOk(req, url)) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (url.pathname === '/api/ping') {
      send(res, 200, { pong: true });
      return;
    }
    // Only GET is supported for the read API (read-only by design).
    if (req.method && req.method !== 'GET') {
      send(res, 405, { error: 'method_not_allowed' });
      return;
    }
    dispatchApi(url.pathname)
      .then((result) => {
        if (result === null) {
          send(res, 404, { error: 'not_found' });
          return;
        }
        send(res, result.status, result.body);
      })
      .catch(() => {
        // Defensive: never leak a stack/path. Coded error only (redaction policy).
        send(res, 500, { error: 'internal_error' });
      });
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
