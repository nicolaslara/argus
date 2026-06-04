// @argus/server — the M3 route layer. Wires the M2 discovery (discoverProjects /
// discoverRuns) and the M1 loadRun behind the M0 security posture (boundaries.md §4).
//
// Routes (all under /api, all token-gated by index.ts BEFORE this layer is reached):
//   GET /api/projects                          -> ProjectRef[]
//   GET /api/projects/:slug/runs               -> RunSummary[]
//   GET /api/runs/:slug/:session/:runId        -> RunModel (snapshot)
//
// Security invariants enforced here (in addition to index.ts's bind/Host/Origin/token):
//   - strict charset validation on every path segment (slug/session/runId) BEFORE FS
//   - resolve()-verify the final wf_*.json path stays INSIDE claudeHome (path-escape guard)
//   - redaction: never log file contents or full paths (codes/basenames only)
//
// All disk access goes through the injected NodeFileSystemPort; this module never
// imports node:fs. It only uses node:path to build + resolve()-verify paths.

import { resolve, sep } from 'node:path';
import {
  discoverProjects,
  discoverRuns,
  loadRun,
  recoverProjectPath,
  type FileSystemPort,
  type AdapterContext,
} from '@argus/adapter';
import type { ProjectRef, RunModel, RunRef, RunSummary } from '@argus/contract';

/**
 * Strict path-segment charset. Slug dirs are `-Users-...` (alnum + dash), session ids
 * are UUIDs (alnum + dash), runIds are `wf_<id>` (alnum + dash + underscore). We allow
 * the union and explicitly forbid anything that could traverse (`/`, `\`, `.`, `..`,
 * NUL, whitespace). A segment failing this is rejected with 400 BEFORE any FS access.
 */
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/** runId must be a `wf_*` file stem (defense-in-depth on top of the charset check). */
const RUN_ID_RE = /^wf_[A-Za-z0-9_-]+$/;

export function isValidSegment(seg: string): boolean {
  return seg.length > 0 && seg.length <= 256 && SEGMENT_RE.test(seg);
}

export function isValidRunId(runId: string): boolean {
  return isValidSegment(runId) && RUN_ID_RE.test(runId);
}

/**
 * Build the absolute wf_*.json path for a run and resolve()-verify it stays strictly
 * inside `claudeHome`. Returns the absolute path, or null if the resolved path escapes
 * the claude home (belt-and-suspenders on top of the charset check). NEVER throws.
 */
export function safeRunJsonPath(
  claudeHome: string,
  slug: string,
  session: string,
  runId: string,
): string | null {
  if (!isValidSegment(slug) || !isValidSegment(session) || !isValidRunId(runId)) {
    return null;
  }
  const homeAbs = resolve(claudeHome);
  const candidate = resolve(homeAbs, 'projects', slug, session, 'workflows', `${runId}.json`);
  // Must be strictly inside the claude home (prefix + path separator).
  if (candidate !== homeAbs && !candidate.startsWith(homeAbs + sep)) {
    return null;
  }
  return candidate;
}

export interface RouteResult {
  status: number;
  body: unknown;
}

/** A coded error body (no raw paths / file contents — boundaries.md §4 redaction). */
function err(status: number, error: string): RouteResult {
  return { status, body: { error } };
}

export interface RouteDeps {
  port: FileSystemPort;
  claudeHome: string;
}

/** GET /api/projects -> ProjectRef[] */
export async function handleProjects(deps: RouteDeps): Promise<RouteResult> {
  const items: ProjectRef[] = await discoverProjects(deps.port, deps.claudeHome);
  return { status: 200, body: items };
}

/** GET /api/projects/:slug/runs -> RunSummary[] (for the slug's recovered projectPath). */
export async function handleProjectRuns(deps: RouteDeps, slug: string): Promise<RouteResult> {
  if (!isValidSegment(slug)) return err(400, 'bad_request');

  // Resolve the slug to its authoritative ProjectRef(s). A slug can collide across
  // multiple recovered cwds; we union the runs of every ProjectRef sharing this slug.
  const projects = await discoverProjects(deps.port, deps.claudeHome);
  const matching = projects.filter((p) => p.slug === slug);
  if (matching.length === 0) return { status: 200, body: [] as RunSummary[] };

  const runs: RunSummary[] = [];
  for (const project of matching) {
    const projRuns = await discoverRuns(deps.port, project, deps.claudeHome);
    runs.push(...projRuns);
  }
  // Newest first (startTime desc), nulls last — same order discovery uses per-project.
  runs.sort((a, b) => (b.startTime ?? -Infinity) - (a.startTime ?? -Infinity));
  return { status: 200, body: runs };
}

/** GET /api/runs/:slug/:session/:runId -> RunModel snapshot. */
export async function handleRunSnapshot(
  deps: RouteDeps,
  slug: string,
  session: string,
  runId: string,
): Promise<RouteResult> {
  const wfPath = safeRunJsonPath(deps.claudeHome, slug, session, runId);
  if (wfPath === null) return err(400, 'bad_request');

  // Read the header once to recover the authoritative projectPath for the RunRef.
  let header: unknown;
  try {
    header = await deps.port.readJson(wfPath);
  } catch {
    return err(404, 'not_found');
  }
  const o = header && typeof header === 'object' ? (header as Record<string, unknown>) : {};
  const scriptPath = typeof o.scriptPath === 'string' ? o.scriptPath : undefined;
  const projectPath = (scriptPath && recoverProjectPath(scriptPath)) ?? '';

  const ref: RunRef = { projectPath, slug, sessionId: session, runId };
  const ctx: AdapterContext = { ref };

  let model: RunModel;
  try {
    model = await loadRun(deps.port, wfPath, ctx);
  } catch {
    // Defensive: loadRun shouldn't throw on malformed input (the adapter tolerates it),
    // but a hard read failure here is a 404, never a 500 that leaks a stack/path.
    return err(404, 'not_found');
  }
  return { status: 200, body: model };
}
