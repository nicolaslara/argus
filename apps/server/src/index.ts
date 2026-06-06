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

import { createServer, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { ADAPTER_FORMAT } from '@argus/adapter';
import { NodeFileSystemPort } from './fs-port.ts';
import { tokenOk, hostAllowed } from './auth.ts';
import {
  handleProjects,
  handleProjectRuns,
  handleProjectWorkflows,
  handleProjectPlan,
  handleProjectPlanExplanations,
  handleRunSnapshot,
  handleRunExplanations,
  handleRunPlan,
  handleRunLive,
  handleAgentResult,
  handleAgentActivity,
  handleSubUi,
  handleDescribe,
  handleStream,
  type RouteDeps,
  type RouteResult,
} from './routes.ts';
import { ExplanationEngine, explanationsCacheDir } from './explain.ts';
import { SubUiEngine, subUiCacheDir } from './subui.ts';
import { scrubError } from './error-redaction.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.ARGUS_PORT ?? 4317);
const TOKEN = process.env.ARGUS_TOKEN ?? randomBytes(32).toString('hex');

// The claude home we read runs from. Defaults to ~/.claude; overridable for tests.
const CLAUDE_HOME = resolve(process.env.ARGUS_CLAUDE_HOME ?? `${homedir()}/.claude`);

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

// The repo root (this file is apps/server/src/index.ts → up three) is where the
// gitignored .argus/cache lives. Overridable so tests/launchers can relocate it.
const REPO_ROOT = resolve(process.env.ARGUS_REPO_ROOT ?? resolve(import.meta.dirname, '..', '..', '..'));

// PX: the Explanation engine. Default-on, background, content-addressed cache under
// .argus/cache/explanations. Degrades gracefully if `claude` is absent (the runner
// returns null → nodes keep their baseline caption). Disabled via ARGUS_EXPLAIN=0.
const EXPLAIN_ENABLED = process.env.ARGUS_EXPLAIN !== '0';
const explain = EXPLAIN_ENABLED
  ? new ExplanationEngine({ cacheDir: explanationsCacheDir(REPO_ROOT) })
  : undefined;

// #9: the generative sub-UI engine (claude → constrained PanelSpec, cached). Shares the
// EXPLAIN on/off switch (both are `claude -p` features that degrade to a fallback render).
const subui = EXPLAIN_ENABLED ? new SubUiEngine({ cacheDir: subUiCacheDir(REPO_ROOT) }) : undefined;

// One shared read-only port + route deps for the process lifetime.
const deps: RouteDeps = { port: new NodeFileSystemPort(), claudeHome: CLAUDE_HOME, explain, subui };

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
async function dispatchApi(url: URL): Promise<RouteResult | null> {
  const pathname = url.pathname;
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

  // GET /api/projects/:slug/workflows/:file/explanations (PX: the plan poll endpoint).
  // More specific than the /plan + listing routes → matched first.
  const planExplMatch = /^\/api\/projects\/([^/]+)\/workflows\/([^/]+)\/explanations$/.exec(pathname);
  if (planExplMatch) {
    const slug = decodeSegment(planExplMatch[1]!);
    const file = decodeSegment(planExplMatch[2]!);
    if (slug === null || file === null) return { status: 400, body: { error: 'bad_request' } };
    return handleProjectPlanExplanations(deps, slug, file);
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

  // GET /api/runs/:slug/:session/:runId/explanations (PX: the run poll endpoint).
  // More specific than the snapshot route → matched first.
  const runExplMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/explanations$/.exec(pathname);
  if (runExplMatch) {
    const slug = decodeSegment(runExplMatch[1]!);
    const session = decodeSegment(runExplMatch[2]!);
    const runId = decodeSegment(runExplMatch[3]!);
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleRunExplanations(deps, slug, session, runId);
  }

  // GET /api/runs/:slug/:session/:runId/describe (I4: whole-run generative summary).
  const runDescribeMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/describe$/.exec(pathname);
  if (runDescribeMatch) {
    const slug = decodeSegment(runDescribeMatch[1]!);
    const session = decodeSegment(runDescribeMatch[2]!);
    const runId = decodeSegment(runDescribeMatch[3]!);
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleDescribe(deps, slug, session, runId);
  }

  // GET /api/runs/:slug/:session/:runId/subui?agentId=<id> (#9: generative panel).
  const runSubUiMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/subui$/.exec(pathname);
  if (runSubUiMatch) {
    const slug = decodeSegment(runSubUiMatch[1]!);
    const session = decodeSegment(runSubUiMatch[2]!);
    const runId = decodeSegment(runSubUiMatch[3]!);
    const agentId = url.searchParams.get('agentId') ?? '';
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleSubUi(deps, slug, session, runId, agentId);
  }

  // GET /api/runs/:slug/:session/:runId/result?agentId=<id> (R1: the lazy FULL result).
  // More specific than the snapshot route → matched first.
  const runResultMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/result$/.exec(pathname);
  if (runResultMatch) {
    const slug = decodeSegment(runResultMatch[1]!);
    const session = decodeSegment(runResultMatch[2]!);
    const runId = decodeSegment(runResultMatch[3]!);
    const agentId = url.searchParams.get('agentId') ?? '';
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleAgentResult(deps, slug, session, runId, agentId);
  }

  // GET /api/runs/:slug/:session/:runId/activity?agentId=<id> (the per-agent drill-in).
  // More specific than the snapshot route → matched first.
  const runActivityMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/activity$/.exec(pathname);
  if (runActivityMatch) {
    const slug = decodeSegment(runActivityMatch[1]!);
    const session = decodeSegment(runActivityMatch[2]!);
    const runId = decodeSegment(runActivityMatch[3]!);
    const agentId = url.searchParams.get('agentId') ?? '';
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleAgentActivity(deps, slug, session, runId, agentId);
  }

  // GET /api/runs/:slug/:session/:runId/live (L2: the partial live journal snapshot).
  // More specific than the snapshot route → matched first.
  const runLiveMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/live$/.exec(pathname);
  if (runLiveMatch) {
    const slug = decodeSegment(runLiveMatch[1]!);
    const session = decodeSegment(runLiveMatch[2]!);
    const runId = decodeSegment(runLiveMatch[3]!);
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleRunLive(deps, slug, session, runId);
  }

  // GET /api/runs/:slug/:session/:runId/plan (P2: the PER-RUN persisted plan source).
  // More specific than the snapshot route → matched first.
  const runPlanMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/plan$/.exec(pathname);
  if (runPlanMatch) {
    const slug = decodeSegment(runPlanMatch[1]!);
    const session = decodeSegment(runPlanMatch[2]!);
    const runId = decodeSegment(runPlanMatch[3]!);
    if (slug === null || session === null || runId === null) {
      return { status: 400, body: { error: 'bad_request' } };
    }
    return handleRunPlan(deps, slug, session, runId);
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

  if (!hostAllowed(req, ALLOWED_HOSTS, ALLOWED_ORIGINS)) {
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
    if (!tokenOk(req, url, TOKEN)) {
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
    // L3: the SSE live stream needs the RAW response (it stays open + streams), so it is
    // handled here, BEFORE the JSON dispatch path.
    const streamMatch = /^\/api\/runs\/([^/]+)\/([^/]+)\/([^/]+)\/stream$/.exec(url.pathname);
    if (streamMatch) {
      handleStream(deps, res, decodeURIComponent(streamMatch[1]!), decodeURIComponent(streamMatch[2]!), decodeURIComponent(streamMatch[3]!));
      return;
    }
    dispatchApi(url)
      .then((result) => {
        if (result === null) {
          send(res, 404, { error: 'not_found' });
          return;
        }
        send(res, result.status, result.body);
      })
      .catch((err) => {
        // Defensive: never leak a stack/path/token. The coded-body invariant lives in the pure
        // scrubError seam (error-redaction.ts), which is unit-tested against path/stack/token/
        // $bunfs-bearing errors so a future drift can't silently start echoing the message.
        send(res, 500, scrubError(err));
      });
    return;
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, HOST, () => {
  // Redaction (boundaries.md §4): the bearer token is NEVER printed by default — a
  // supervisor / scrollback / log capture must not hold a live credential. The launcher
  // (dev.mjs) shares it via env; set ARGUS_PRINT_TOKEN=1 ONLY to debug locally. (Matches
  // dev.mjs's gate; fixes arch-review risk #1.)
  process.stdout.write(`argus server on http://${HOST}:${PORT}  (format ${ADAPTER_FORMAT})\n`);
  if (process.env.ARGUS_PRINT_TOKEN === '1') {
    process.stdout.write(`ARGUS_TOKEN=${TOKEN}\n`);
  }
});
